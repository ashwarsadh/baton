# How Baton works

```
 phone / browser ──HTTPS (Cloudflare) or Tailscale/LAN──►  app port 8790  ─┐
                                                                          │   Baton daemon (Node.js)
 Claude Code sessions ──MCP (stdio)── mcp/baton-mcp.js ──► control 8788 ─┤    server.js
                                                                          │
         reads files ◄────────────────────────────────────────────────────┤
   %APPDATA%\Claude\claude-code-sessions\…\local_*.json   (session list)  │
   ~/.claude/projects/<folder>/<session>.jsonl            (transcripts)   │
                                                                          │
         acts through ────────────────────────────────────────────────────┘
   Claude Desktop main-process debugger (127.0.0.1:9229)
```

## Reading is files, acting is the desktop app

- **The session list** comes from the JSON files Claude Desktop writes for every Code session
  (title, folder, model, effort, archived). **Transcripts** are the Claude Code `.jsonl` files,
  read from the end so a long session loads quickly. Neither needs the desktop app to be running.
- **Status dots, groups and unread state** come from a passive read of the desktop sidebar every
  30 seconds. It never opens a session just to look at it.
- **Actions** (send, answer a question or permission, change model or effort, rename, archive, start
  a session, press a background-task chip) go through Claude Desktop's main-process debugger.
  Where the app has an internal method for it — for example sending a message to a session — Baton
  calls that method directly (`lib/bridge.js`), which needs no clicking. Otherwise it drives the UI
  the way you would (`lib/desktop.js`).
- All UI driving is serialised through one lane, and waits until you have been away from the
  keyboard and mouse for the idle gate, so it never types into what you are doing.

## Modules

| Module | Code |
|---|---|
| App | `mobile/` — HTTP server, server-sent events, push (`mobile/push.js`), the web app in `mobile/public/` |
| Auto-resume | `lib/resume.js` — usage-limit and crash resume |
| Orchestrator | `lib/orchestrator.js`, `lib/worker.js`, `lib/gui-worker.js`, `lib/router.js`, `mcp/baton-mcp.js` |
| Wake the master | `lib/notify.js`, `lib/await.js`, `lib/goal.js` |
| Auto-start chips | `lib/chipwatch.js` |
| Board | `mobile/board.js`, `mobile/public/board-ui.js` |
| Remote access | `lib/tunnel.js` (cloudflared), `lib/pair.js` (links + QR), `mobile/access.js` (Cloudflare Access) |
| Settings | `lib/config.js` (`~/.baton/settings.json`, hot-reloaded), `mobile/public/settings-ui.js` |

## Workers

`baton_spawn` runs a task either **headless** (`claude -p`, fast, invisible, needs the Claude Code
CLI to be logged in) or as a **visible Desktop session** (uses the account you are signed in to in
the app). `auto` picks headless when the CLI is logged in. Model and effort are chosen per task by
`lib/router.js` from the default model in Settings; a failed task can be escalated one rung.

## Resume

A session stopped by a usage limit records when the limit resets; Baton sends it a short
continuation at that time. A session that was mid-turn when Claude Desktop exited is detected on the
next start and continued. Sessions the app will resume on its own are left alone.

## Limits

Claude Desktop's UI and debugger are not a public API. A desktop update can change the markup Baton
drives; reads keep working because they only use files. File an issue with `baton status` output
when an action stops working.
