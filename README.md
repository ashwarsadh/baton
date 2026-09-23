<p align="center">
  <img src="assets/logo.svg" width="112" alt="Baton logo">
</p>

<h1 align="center">Baton</h1>

<p align="center"><b>Your Claude Code sessions, in your pocket.</b><br>
A phone and desktop client for the Code tab of Claude Desktop — every session, live, with auto-resume and a conductor for running many at once.</p>

<p align="center">
  <img src="docs/img/shot-sessions.png" width="220" alt="Session list">
  <img src="docs/img/shot-chat.png" width="220" alt="A session on the phone">
  <img src="docs/img/shot-pair.png" width="220" alt="Pair a phone with a QR code">
</p>

---

## Why

You start a few Claude Code sessions on your computer, walk away, and they stop: one asks a
question, one needs a permission, one hits the usage limit, one finishes and waits. Baton puts all of
them on your phone and keeps them moving.

- **Every session, live.** The same list the desktop app shows — read the conversation, reply, answer
  questions and permission prompts, switch model and effort, rename, archive, start new sessions in
  any folder, attach photos and files.
- **Push notifications** when a session needs you or finishes.
- **Nothing stalls.** Sessions stopped by a usage limit continue when the limit resets. Sessions cut
  off because Claude Desktop crashed or restarted pick up where they were.
- **A conductor for many sessions.** Tell one session *"you are the master for this project"* and it
  gets tools to spawn workers, track them, set their model and effort, start suggested background
  tasks, and be woken when they finish — while you are away.
- **Reach it from anywhere.** One click gives you an HTTPS address through Cloudflare (free, with or
  without an account), or use Tailscale or your Wi-Fi. Scan a QR code and you're in.
- **Modular.** Use it as just a phone client, or switch on the orchestration features. Every feature
  is a toggle in Settings.
- **Same app on desktop.** Open it on your computer and you get a two-pane layout with the same
  sessions, in sync.

<p align="center"><img src="docs/img/shot-desktop.png" width="720" alt="Baton on a desktop browser"></p>

## How it works (in one paragraph)

Baton is a small Node.js service that runs next to Claude Desktop on your computer. It reads your
sessions and transcripts straight from disk (Claude Desktop already keeps them there), and it acts on
them — sending a message, answering a question, resuming — through Claude Desktop's own
**main-process debugger**, the switch under *Developer › Enable Main Process Debugger*. Nothing is
registered with a third party, nothing is copied to a cloud, and it uses the Claude account you are
already signed in to. Your phone talks to that service over a private link protected by an access key.
More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- **Claude Desktop** with the Code tab, signed in (Windows is the primary platform; macOS is
  experimental — see [Platform support](#platform-support)).
- **Node.js 18+**.
- Optional: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  for access from anywhere, or [Tailscale](https://tailscale.com).

## Install

```bash
git clone https://github.com/ashwarsadh/baton.git
cd baton
npm install
npm link          # makes the `baton` command available (or run: node bin/baton.js)
baton setup
```

`baton setup` checks everything, switches on Claude Desktop's debugger (Windows), registers the
orchestrator tools with Claude Code, adds Baton to start with Windows (with a tray icon), and opens
the app. Then go to **Settings › Pair a phone** and scan the QR code.

### Turn on the debugger by hand

If `baton setup` could not do it: in Claude Desktop open **Help › Troubleshooting › Enable Developer
Mode**, then **Developer › Enable Main Process Debugger**, and press OK. Check with `baton status`.
The debugger switches off when Claude Desktop restarts; Baton notices and turns it back on
(Windows), or tells you.

## Reach it from your phone

Open **Settings › Remote access** and pick one:

| Option | Account needed | Address | Best for |
|---|---|---|---|
| This computer only | — | `http://127.0.0.1:8790` | trying it out |
| Same Wi-Fi | — | `http://192.168.x.x:8790` | at home, no push notifications |
| Tailscale | Tailscale | `http://100.x.y.z:8790` | private, simple |
| **Anywhere — quick link** | none | `https://random-words.trycloudflare.com` | instant; changes on restart |
| **Anywhere — my own address** | free Cloudflare account + a domain | `https://baton.yourdomain.com` | daily use; never changes |

For your own address: press **Log in to Cloudflare**, authorise the domain in the page that opens,
type the hostname you want (e.g. `baton.example.com`) and press **Create**. Baton creates the tunnel
and the DNS record for you. From the command line the same thing is:

```bash
baton tunnel login
baton tunnel setup baton.example.com
baton restart && baton pair
```

Whatever you choose, the app still requires your access key (it is inside the QR code and is then
kept as a cookie), so an address alone lets nobody in. You can add Cloudflare Access (email login) on
top — see Settings › Remote access.

On the phone, use the browser's **Add to Home screen** to install Baton like an app. Push
notifications need HTTPS, so they work over the Cloudflare options.

## Settings and modules

Everything is in **Settings** (the ⚙ in the session list, or *Settings* in the tray menu):

<p align="center"><img src="docs/img/shot-modules.png" width="260" alt="Settings: modules"></p>


| Module | Default | What it does |
|---|---|---|
| Phone & desktop app | on | The app itself |
| Auto-resume | on | Resume after a usage limit resets, or after a Desktop crash |
| Orchestrator | on | The `baton_*` tools that let a session act as master |
| Wake the master | on | Tell the master when a worker finishes or asks something |
| Auto-start task chips | off | Press *Start* on suggested background tasks in sessions a master owns |
| Routines | on | Show Claude Code scheduled tasks |
| Board | off | A tappable to-do board from `board.json` ([docs/BOARD.md](docs/BOARD.md)) |
| Accounts | off | Experimental: see several Claude accounts on one computer |

**Idle gate.** Some actions drive the Claude Desktop window. Baton waits until you have not touched
the keyboard or mouse for a few seconds (15 by default) so it never types into what you're doing.

Settings live in `~/.baton/settings.json`; all of Baton's data is under `~/.baton` (override with
`BATON_HOME`).

## The conductor: many sessions, one master

With the Orchestrator module on and the MCP server registered (`baton mcp install`), every Claude
Code session gets a small set of `baton_*` tools. By default a session is a **worker** and can only
read status. When you tell a session *"you are the master for this project — coordinate the other
sessions"*, it calls `baton_become_master`, receives a short operating protocol, and can then:

- `baton_spawn` workers (headless `claude -p`, or visible Desktop sessions) with model and effort
  picked per task; `baton_tasks`, `baton_escalate`, `baton_stop`
- `baton_fleet`, `baton_list_sessions`, `baton_set_group`, `baton_rename`, `baton_archive`
- `baton_pending_tasks`, `baton_start_task`, `baton_dismiss_task` for background-task chips
- `baton_set_model`, `baton_set_effort`, `baton_fast_mode`
- `baton_goal` (a completion condition a session keeps working towards) and `baton_await` (park
  until workers report, woken by Baton instead of polling)
- `baton_resume`, `baton_unstick`, `baton_heal` when something is stuck

Only one master per project at a time; every claim and action is logged to
`~/.baton/state/master-audit.log`. Optionally, name one session your **Conductor** in Settings ›
Advanced: masters report up to it, and the Board sends your taps to it.

## Command line

```text
baton setup | open | pair | status
baton start | stop | restart | tray | autostart [remove]
baton debugger | mcp install | mcp remove
baton tunnel quick | login | setup <hostname> | off | status
baton run <task> | ls | show <id> | stop <id> | sessions | health
```

## Platform support

| | Windows | macOS | Linux |
|---|---|---|---|
| Read sessions, transcripts | ✅ | ✅ | — (no Claude Desktop) |
| Send, answer, model/effort, resume | ✅ | experimental | — |
| Tray icon, autostart, debugger auto-enable | ✅ | manual | — |
| Idle gate | ✅ | not yet (always idle) | — |

Baton depends on Claude Desktop's internal UI and debugger, which are not a public API. An update to
Claude Desktop can break an action until Baton is updated; reading sessions keeps working because it
only uses files on disk.

## Security

- The app port requires the access key (bearer token or cookie); the control port binds to
  `127.0.0.1` only.
- The access key is stored in `~/.baton/mobile/secret.json`. **Settings › Pair a phone › Issue a new
  key** signs every device out.
- Sub-users (`node mobile/subusers.js`) get their own key limited to specific sessions.
- Anyone with the key can send messages to your Claude sessions, which can run commands on your
  computer. Treat the pairing link like a password.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Try it without Claude Desktop

```bash
node test/make-demo.js ./demo
BATON_HOME=./demo/baton APPDATA=./demo/appdata CLAUDE_CONFIG_DIR=./demo/claude node server.js
```

Then open the link from `BATON_HOME=./demo/baton baton pair`. `npm test` runs a smoke test in a
throwaway folder.

## Not affiliated with Anthropic

Baton is an independent open-source project. "Claude" and "Claude Code" are trademarks of
Anthropic. Baton does not handle your Anthropic credentials; it drives the Claude Desktop app you are
already signed in to.

## License

[MIT](LICENSE)
