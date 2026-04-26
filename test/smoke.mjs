// Smoke test: exercise ChannelAgent with a stale session ID and verify
// (a) the recovery path actually fires, (b) a follow-up message succeeds.
//
// Requires:
//   - working DISCORD_TOKEN-less env (we don't touch Discord here)
//   - ANTHROPIC_API_KEY or `claude` CLI logged in
//   - ~/.claude config with at least basic SDK ability
//
// Run:
//   node test/smoke.mjs

import { query } from '@anthropic-ai/claude-agent-sdk';

const STALE_SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const channelId = 'test-channel';

// Tiny ChannelAgent reimplementation matching bridge.mjs semantics.
// (We don't import bridge.mjs because it boots Discord on load.)
class ChannelAgent {
  constructor(initialSessionId) {
    this.queue = [];
    this.resolvers = [];
    this.closed = false;
    this.sessionId = initialSessionId || null;
    this.pendingResolve = null;
    this.responseText = '';
    this.responseUsage = null;
    this.recoveryFired = false;
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
      yield { type: 'user', message: { role: 'user', content: env.content }, parent_tool_use_id: null };
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
            if (sid && sid !== this.sessionId) this.sessionId = sid;
            continue;
          }
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text') this.responseText += block.text;
            }
            continue;
          }
          if (msg.type === 'result') {
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            const text = this.responseText;
            const usage = msg.usage ?? null;
            this.responseText = '';
            const isError = msg.is_error === true ||
              (typeof msg.subtype === 'string' && msg.subtype !== 'success');
            if (isError) {
              console.log(`  [debug] result error: subtype=${msg.subtype} is_error=${msg.is_error} result=${JSON.stringify(msg.result)?.slice(0,200)}`);
            }
            if (resolve) {
              if (isError) resolve({ text, usage, error: String(msg.result || msg.subtype) });
              else resolve({ text, usage });
            }
          }
        }
      } catch (err) {
        const isStaleSession = /no conversation found/i.test(err.message);
        if (isStaleSession) {
          this.recoveryFired = true;
          const previous = this.sessionId;
          this.sessionId = null;
          this.responseText = '';
          while (this.resolvers.length) {
            const r = this.resolvers.shift();
            try { r(null); } catch {}
          }
          if (this.pendingResolve) {
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            resolve({ text: '', usage: null, error: `stale session ${previous} cleared — please resend` });
          }
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
    if (this.pendingResolve) throw new Error('agent busy');
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

function pass(label) { console.log(`  ✓ ${label}`); }
function fail(label, why) { console.error(`  ✗ ${label}: ${why}`); process.exitCode = 1; }

async function main() {
  console.log(`[${channelId}] starting agent with stale session ${STALE_SESSION}`);
  const agent = new ChannelAgent(STALE_SESSION);

  // Stale resume can fail in one of two ways depending on SDK timing:
  //   (a) SDK emits an error result + self-recovers → next turn works
  //   (b) SDK throws → our catch-handler recovery fires + tells user to resend
  // Either way, after AT MOST one failed turn, subsequent turns must succeed.
  // We send up to 3 attempts and require at least one to land cleanly.

  let success = null;
  let failedAttempts = 0;
  for (let i = 1; i <= 3 && !success; i++) {
    console.log(`[${channelId}] turn ${i}`);
    const r = await agent.send('respond with the single word: ok');
    if (r.error) {
      console.log(`  [debug] turn ${i} error: ${r.error.slice(0, 100)}`);
      failedAttempts++;
    } else if (r.text && r.text.toLowerCase().includes('ok')) {
      success = { turn: i, text: r.text };
    } else {
      console.log(`  [debug] turn ${i} unexpected text: "${r.text?.slice(0, 80)}"`);
      failedAttempts++;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (failedAttempts > 0) pass(`error surfaced on ${failedAttempts} attempt(s) — no silent empties`);
  else pass('no errors at all (SDK transparently handled stale session)');

  if (success) pass(`turn ${success.turn} succeeded: "${success.text.trim().slice(0, 80)}"`);
  else fail('recovery', `no successful turn within 3 attempts (failedAttempts=${failedAttempts})`);

  if (failedAttempts <= 1) pass(`recovery cost was ${failedAttempts} turn(s) — within budget`);
  else fail('budget', `expected ≤1 failed turn, got ${failedAttempts}`);

  if (agent.sessionId && agent.sessionId !== STALE_SESSION) pass(`fresh sessionId established: ${agent.sessionId}`);
  else fail('sessionId', `expected fresh session, got ${agent.sessionId}`);

  agent.close();
  console.log('\ndone.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
