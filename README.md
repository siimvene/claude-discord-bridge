# claude-discord-bridge

A Discord bot that wraps [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) so each Discord channel becomes its own persistent Claude conversation.

- **Persistent sessions per channel.** One `query()` stays alive forever per channel — warm turns land in 1.5–2s instead of the 5–12s you get from spawning `claude -p` per message.
- **Native image attachments.** Attached PNG/JPG/WEBP/GIF images flow through as real `image` content blocks (base64). Non-image files get saved to `/tmp` with a path injected so Claude can `Read` them.
- **File-based access control.** A JSON file says which Discord channels are wired up, who can talk in them, and whether `@mention` is required.
- **Survives restarts.** A small pointer file (`state/sessions.json`) maps `channelId → sessionId`; on next boot the SDK resumes the on-disk jsonl transcript and the conversation continues.
- **Context window bar embed.** Every reply gets a tiny `█░░░░░░░░░ 8% · Turn 12 · 81.0k / 1000k tokens` footer so you can see where you are in the window.

> **Status: experimental.** Working in production for the author, but there are known bugs (see [Known issues](#known-issues)) and the security posture is permissive by design (see [Security](#security)).

---

## Security — read this first

This bot runs the Claude Agent SDK with `permissionMode: 'bypassPermissions'`. That means **anyone authorized to talk to the bot in Discord can run arbitrary shell commands on the host machine, read any file the bot's user can read, and use any tool the SDK has access to** (including any MCP servers you've configured).

Treat your `access.json` like an SSH `authorized_keys` file. Specifically:

- Use `allowFrom` to whitelist specific Discord user IDs. Don't leave channels open to "anyone in the server".
- Run the bot as a dedicated, unprivileged user — not your main account.
- Don't run it on a host with secrets you wouldn't paste in a chat.
- If you can, sandbox it (container, VM, separate machine).

If this isn't the trade-off you want, this is the wrong project. A version with restricted permissions and an explicit allow-list of tools would be a meaningful fork.

---

## Quick start

```bash
git clone <your-fork>
cd claude-discord-bridge
npm install
cp .env.example .env             # add your DISCORD_TOKEN
cp access.json.example access.json  # add your channel IDs and user IDs
npm start
```

To run the smoke test (exercises ChannelAgent against a stale session ID — needs a working SDK login):

```bash
npm test
```

To run as a systemd user service:

```bash
cp claude-discord-bridge.service.example ~/.config/systemd/user/claude-discord-bridge.service
# edit paths inside, then
systemctl --user daemon-reload
systemctl --user enable --now claude-discord-bridge.service
journalctl --user -u claude-discord-bridge -f
```

### Discord bot setup

1. Create an application at <https://discord.com/developers/applications>.
2. Add a bot, copy its token into `.env` as `DISCORD_TOKEN`.
3. Enable the **Message Content Intent** under "Bot → Privileged Gateway Intents".
4. Invite the bot to your server with the `bot` scope and `Send Messages` + `Read Message History` permissions.
5. Right-click each channel you want to enable → "Copy Channel ID" (Developer Mode required) → put the IDs in `access.json`.

---

## How it works

```
Discord message
   ↓
discord.js messageCreate
   ↓
shouldProcess()  ← access.json check (group, allowFrom, requireMention)
   ↓
queues.get(channelId).push(message)        ← per-channel FIFO
   ↓
processQueue()  ← channelBusy guard, one turn at a time per channel
   ↓
buildContent(text, attachments)
   → string  (text-only)
   → [{type:'text'}, {type:'image', source:{type:'base64',...}}, ...]
   ↓
getAgent(channelId)  ← reuse the persistent ChannelAgent
   ↓
agent.send(content)  ← yields to the long-lived query() generator
   ↓
SDK pipes to claude binary subprocess
   ↓
streams back: system/init, assistant deltas, result
   ↓
msg.reply(text) + context bar embed
```

Each channel gets one `ChannelAgent` instance, which keeps a `query()` async iterator alive forever. Turns are yielded into a queue-backed feed generator instead of spawning a new SDK process per message.

### Session storage

Sessions are stored where the SDK puts them:

```
~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
```

The `sanitized-cwd` is the SDK process's working directory with `/` replaced by `-`. So a bridge running in `/home/you/projects/claude-discord-bridge` stores sessions under `~/.claude/projects/-home-you-projects-claude-discord-bridge/`.

Across restarts, `state/sessions.json` (in the bridge directory) is the pointer file mapping each channel to its session ID. When the bridge wakes, it reads this map and tells the SDK `options.resume = sessionId` for each channel's first message.

### What loads when the bot starts

The SDK boots as a normal `claude` invocation, so it loads everything `claude -p` would:

- `~/CLAUDE.md` and any project-level `CLAUDE.md` walking up from the bridge's cwd
- `~/.claude/settings.json` (hooks, MCP servers, model defaults)
- `~/.claude/agents/` (subagents)
- `~/.claude/skills/` (skills)
- `~/.claude/commands/` (slash commands)

If you want a per-channel persona or different MCP set, you'd need to fork and pass `options.systemPrompt` / `options.mcpServers` per channel.

### Latency

| Turn | First-byte latency |
|------|--------------------|
| Cold start (first message after restart, per channel) | ~8s (one-time, Claude binary spawns + MCP servers boot + jsonl replays) |
| Warm turn | ~1.5–2s |

### Special commands

- `!!clear` in any allowed channel — closes the agent for that channel, drops the session pointer and turn count, recreates fresh on the next message.

---

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | (required) | Bot token from the Discord developer portal |
| `ACCESS_JSON` | `./access.json` | Path to access policy JSON |
| `STATE_DIR` | `./state` | Where `sessions.json` lives |
| `CONTEXT_WINDOW` | `1000000` | Window size for the progress bar (use `200000` for non-1M models) |
| `MAX_ATTACHMENT_BYTES` | `26214400` (25 MiB) | Cap on per-attachment download size |

### `access.json` schema

```json
{
  "groups": {
    "<channelId>": {
      "allowFrom": ["<userId>", ...],   // optional whitelist; omit to allow anyone in the channel
      "requireMention": true             // if true, only respond when @mentioned or replied-to
    }
  }
}
```

The file is hot-reloaded on `mtime` change — edit it without restarting.

---

## Known limits

- **Single-tenant assumption.** All channels share one process, one Discord token, one `~/.claude/` config tree. There's no per-channel persona / MCP isolation. (See [#per-channel-config](#per-channel-config) — it's the obvious next feature.)
- **Token usage tracking is approximate.** The bar uses cumulative input+output tokens reported by the SDK, which doesn't perfectly match what the model sees as "context used" after caching/compaction.
- **Stale-session recovery costs one turn.** If the bridge restarts pointing at a session that no longer exists, the first message in that channel surfaces `"turn failed during execution (likely stale session — please retry)"`; resending succeeds against a freshly created session. The SDK self-recovers; we just can't paper over the failed turn.

---

## Architecture notes for forkers

- `bridge.mjs` is intentionally one file (~400 lines). If you're comfortable reading Node, the whole thing fits in your head.
- `ChannelAgent` (the per-channel persistent SDK wrapper) is the meat. Everything else is plumbing.
- The queue-backed async generator pattern (`_feed()`) is what lets `query()` stay alive while messages arrive on Discord's event loop. The SDK v2's `send()` API would be cleaner but doesn't natively support image content blocks at the time of writing — hence the v1 `query()` approach.

---

## License

MIT — see [LICENSE](LICENSE).
