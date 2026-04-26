import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACCESS_JSON = process.env.ACCESS_JSON || path.join(__dirname, 'access.json');
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW || 1_000_000);
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024);
// Anthropic Messages API caps images at 5MB raw and 8000x8000 px. We can't easily
// check dimensions without decoding, but we can enforce the byte cap up front.
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024);

fs.mkdirSync(STATE_DIR, { recursive: true });

// ----- state -----
const sessions = new Map();
const turnCounts = new Map();
const cumulativeTokens = new Map();

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data.sessions || {})) sessions.set(k, v);
    for (const [k, v] of Object.entries(data.tokens || {})) cumulativeTokens.set(k, v);
    for (const [k, v] of Object.entries(data.turns || {})) turnCounts.set(k, v);
    console.log(`[state] loaded ${sessions.size} sessions from ${STATE_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[state] load failed: ${err.message}`);
  }
}

let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = {
      sessions: Object.fromEntries(sessions),
      tokens: Object.fromEntries(cumulativeTokens),
      turns: Object.fromEntries(turnCounts),
    };
    try {
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (err) {
      console.error(`[state] save failed: ${err.message}`);
    }
  }, 500);
}

// ----- access policy -----
let accessCache = { mtime: 0, data: null };
function loadAccess() {
  try {
    const stat = fs.statSync(ACCESS_JSON);
    if (stat.mtimeMs !== accessCache.mtime) {
      accessCache = { mtime: stat.mtimeMs, data: JSON.parse(fs.readFileSync(ACCESS_JSON, 'utf8')) };
      console.log(`[access] reloaded (${Object.keys(accessCache.data.groups || {}).length} channels)`);
    }
    return accessCache.data;
  } catch (err) {
    console.error(`[access] load failed: ${err.message}`);
    return { groups: {} };
  }
}

async function shouldProcess(message, clientUserId) {
  if (message.author.bot) return false;
  const access = loadAccess();
  const group = access.groups?.[message.channel.id];
  if (!group) return false;
  if (group.allowFrom?.length && !group.allowFrom.includes(message.author.id)) return false;
  if (group.requireMention) {
    if (message.mentions.has(clientUserId)) return true;
    if (message.reference) {
      try {
        const ref = await message.fetchReference();
        if (ref.author.id === clientUserId) return true;
      } catch {}
    }
    return false;
  }
  return true;
}

// ----- attachment handling -----
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

async function fetchAttachments(msg) {
  if (msg.attachments.size === 0) return [];
  const out = [];
  for (const att of msg.attachments.values()) {
    try {
      const isImage = att.contentType && IMAGE_MIME.test(att.contentType);
      const cap = isImage ? Math.min(MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES) : MAX_ATTACHMENT_BYTES;
      if (att.size > cap) {
        const sizeMb = (att.size / 1024 / 1024).toFixed(1);
        const capMb = (cap / 1024 / 1024).toFixed(1);
        throw new Error(
          isImage
            ? `image ${sizeMb}MB exceeds ${capMb}MB Anthropic API limit`
            : `attachment ${sizeMb}MB exceeds ${capMb}MB limit`
        );
      }
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      out.push({ name: att.name, type: att.contentType, size: att.size, data: buf });
    } catch (err) {
      console.error(`[${msg.channel.id}] att fail: ${att.name}: ${err.message}`);
      out.push({ name: att.name, type: att.contentType, size: att.size, error: err.message });
    }
  }
  return out;
}

function buildContent(text, attachments) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });

  const failed = [];
  const savedPaths = [];
  for (const att of attachments) {
    if (att.error) {
      failed.push(`${att.name ?? 'unnamed'} (failed: ${att.error})`);
      continue;
    }
    if (att.data && att.type && IMAGE_MIME.test(att.type)) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: att.type, data: att.data.toString('base64') },
      });
    } else if (att.data) {
      // Non-image: write to /tmp and inject path so Claude can Read it
      const safe = (att.name || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_');
      const dest = `/tmp/discord-${Date.now()}-${safe}`;
      fs.writeFileSync(dest, att.data);
      savedPaths.push(`${dest} (${att.type ?? 'unknown'}, ${att.size}b)`);
    }
  }
  if (savedPaths.length || failed.length) {
    let note = '';
    if (savedPaths.length) note += `\n\n[attachments: ${savedPaths.join(', ')}]`;
    if (failed.length) note += `\n\n[failed: ${failed.join(', ')}]`;
    if (blocks.length === 0) blocks.push({ type: 'text', text: '(attachment)' });
    blocks[0].text = (blocks[0].text || '') + note;
  }

  if (blocks.length === 0) return null;
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

// ----- per-channel agent -----
class ChannelAgent {
  constructor(channelId) {
    this.channelId = channelId;
    this.queue = [];
    this.resolvers = [];
    this.closed = false;
    this.busy = false;
    this.sessionId = sessions.get(channelId) || null;
    this.pendingResolve = null;
    this.responseText = '';
    this.responseUsage = null;
    this._startStream();
  }

  _push(envelope) {
    if (this.resolvers.length) this.resolvers.shift()(envelope);
    else this.queue.push(envelope);
  }

  async *_feed() {
    while (!this.closed) {
      const env = this.queue.length ? this.queue.shift() : await new Promise(r => this.resolvers.push(r));
      if (env === null) break;
      yield {
        type: 'user',
        message: { role: 'user', content: env.content },
        parent_tool_use_id: null,
      };
    }
  }

  _startStream() {
    const options = { permissionMode: 'bypassPermissions' };
    if (this.sessionId) options.resume = this.sessionId;

    this.stream = query({ prompt: this._feed(), options });

    (async () => {
      try {
        for await (const msg of this.stream) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            const sid = msg.session_id ?? msg.sessionId;
            if (sid && sid !== this.sessionId) {
              this.sessionId = sid;
              sessions.set(this.channelId, sid);
              saveState();
              console.log(`[${this.channelId}] session=${sid}`);
            }
            continue;
          }
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text') this.responseText += block.text;
            }
            continue;
          }
          if (msg.type === 'result') {
            this.responseUsage = msg.usage ?? null;
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            const text = this.responseText;
            const usage = this.responseUsage;
            this.responseText = '';
            this.responseUsage = null;
            // SDK signals errors via `is_error` / non-success subtypes on the result
            // message. Surface them; otherwise the user sees a silent empty reply.
            // (The SDK may also throw on the next iteration — handled in catch.)
            const isError = msg.is_error === true ||
              (typeof msg.subtype === 'string' && msg.subtype !== 'success');
            if (resolve) {
              if (isError) {
                let reason;
                if (msg.result) {
                  reason = String(msg.result);
                } else if (msg.subtype === 'error_during_execution' && this.sessionId) {
                  // Most common cause when we'd been resuming: target session is gone.
                  // SDK self-recovers on the next turn; tell the user to retry.
                  reason = 'turn failed during execution (likely stale session — please retry)';
                } else {
                  reason = msg.subtype || 'execution error';
                }
                resolve({ text, usage, error: String(reason) });
              } else {
                resolve({ text, usage });
              }
            }
          }
        }
      } catch (err) {
        console.error(`[${this.channelId}] stream error: ${err.message}`);
        const isStaleSession = /no conversation found/i.test(err.message);
        if (isStaleSession) {
          // The previous resume target is gone. Clear pointer state, terminate any
          // stale _feed() awaits routed to the dead generator, then start a fresh
          // stream that will create a new session on next yield.
          const previous = this.sessionId;
          this.sessionId = null;
          sessions.delete(this.channelId);
          saveState();
          this.responseText = '';
          this.responseUsage = null;
          while (this.resolvers.length) {
            const r = this.resolvers.shift();
            try { r(null); } catch {}
          }
          if (this.pendingResolve) {
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            resolve({
              text: '',
              usage: null,
              error: `stale session ${previous || '(unknown)'} cleared — please resend`,
            });
          }
          console.log(`[${this.channelId}] stale session ${previous || '(unknown)'} — cleared, restarting stream`);
          this._startStream();
          return;
        }
        if (this.pendingResolve) {
          this.pendingResolve({ text: '', usage: null, error: err.message });
          this.pendingResolve = null;
        }
        this.closed = true;
      }
    })();
  }

  async send(content) {
    if (this.closed) throw new Error('agent closed');
    if (this.pendingResolve) throw new Error('agent busy with previous turn');
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this._push({ content });
    });
  }

  close() {
    this.closed = true;
    while (this.resolvers.length) this.resolvers.shift()(null);
  }
}

// ----- bridge -----
const agents = new Map();
const queues = new Map();
const channelBusy = new Map();

function getAgent(channelId) {
  let a = agents.get(channelId);
  if (!a || a.closed) {
    a = new ChannelAgent(channelId);
    agents.set(channelId, a);
  }
  return a;
}

function buildContextEmbed(channelId) {
  const turn = turnCounts.get(channelId) || 0;
  const tok = cumulativeTokens.get(channelId) || { total: 0 };
  const fillPct = Math.min(tok.total / CONTEXT_WINDOW, 1);
  const fillRounded = Math.round(fillPct * 100);
  const filled = Math.round(fillPct * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const tokensK = (tok.total / 1000).toFixed(1);
  const windowK = (CONTEXT_WINDOW / 1000).toFixed(0);
  const footer = `${bar} ${fillRounded}% · Turn ${turn} · ${tokensK}k / ${windowK}k tokens`;
  const color = fillRounded >= 75 ? 0xed4245 : fillRounded >= 50 ? 0xfee75c : 0x57f287;
  return new EmbedBuilder().setColor(color).setFooter({ text: footer });
}

function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= maxLen) { chunks.push(text); break; }
    let idx = text.lastIndexOf('\n', maxLen);
    if (idx < maxLen * 0.3) idx = text.lastIndexOf(' ', maxLen);
    if (idx < maxLen * 0.3) idx = maxLen;
    chunks.push(text.slice(0, idx));
    text = text.slice(idx).trimStart();
  }
  return chunks;
}

async function processQueue(channelId) {
  if (channelBusy.get(channelId)) return;
  channelBusy.set(channelId, true);
  const queue = queues.get(channelId) || [];

  while (queue.length > 0) {
    const msg = queue.shift();
    const baseText = msg.content.replace(/<@!?\d+>/g, '').trim();
    const attachments = await fetchAttachments(msg);
    if (!baseText && attachments.length === 0) continue;

    if (baseText === '!!clear') {
      const a = agents.get(channelId);
      if (a) { a.close(); agents.delete(channelId); }
      sessions.delete(channelId);
      turnCounts.delete(channelId);
      cumulativeTokens.delete(channelId);
      saveState();
      console.log(`[${channelId}] cleared by !!clear`);
      await msg.reply('Session cleared. Next message starts fresh.').catch(() => {});
      continue;
    }

    const content = buildContent(baseText, attachments);
    if (!content) continue;

    try {
      await msg.channel.sendTyping().catch(() => {});
      const typingTimer = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

      const agent = getAgent(channelId);
      const t0 = Date.now();
      console.log(`[${channelId}] send: ${typeof content === 'string' ? content.slice(0,80) : `[${content.length} blocks]`}`);

      const result = await agent.send(content);
      clearInterval(typingTimer);
      console.log(`[${channelId}] turn ${(turnCounts.get(channelId) ?? 0) + 1} done in ${Date.now() - t0}ms`);

      turnCounts.set(channelId, (turnCounts.get(channelId) || 0) + 1);
      if (result.usage) {
        const prev = cumulativeTokens.get(channelId) || { input: 0, output: 0, total: 0 };
        prev.input += result.usage.input_tokens || 0;
        prev.output += result.usage.output_tokens || 0;
        prev.total = prev.input + prev.output;
        cumulativeTokens.set(channelId, prev);
      }
      saveState();

      const text = result.text || (result.error ? `Error: ${result.error}` : '*(empty response)*');
      const chunks = splitMessage(text);
      const barEmbed = buildContextEmbed(channelId);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        if (isLast) await msg.reply({ content: chunks[i], embeds: [barEmbed] });
        else await msg.reply(chunks[i]);
      }
    } catch (err) {
      console.error(`[${channelId}] error: ${err.message}`);
      await msg.reply(`Error: ${err.message}`).catch(() => {});
    }
  }

  channelBusy.set(channelId, false);
}

// ----- discord client -----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Access: ${ACCESS_JSON}`);
  console.log(`State: ${STATE_FILE}`);
  loadAccess();
});

client.on('messageCreate', async (message) => {
  if (!(await shouldProcess(message, client.user?.id))) return;
  if (!queues.has(message.channel.id)) queues.set(message.channel.id, []);
  queues.get(message.channel.id).push(message);
  processQueue(message.channel.id);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM — closing agents');
  for (const a of agents.values()) a.close();
  client.destroy().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});

loadState();
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
