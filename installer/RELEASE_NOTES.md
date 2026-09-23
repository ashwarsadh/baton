Baton puts your Claude Desktop Code-tab sessions on your phone and in a desktop web app. Each download below includes its own Node.js 22 LTS runtime, so you do not need to install Node.

## 0.2.3

Windows: no Baton command opens a console window any more. `baton setup`, `baton debugger` and the
MCP registration (also run by the uninstaller) now start their helpers hidden; in a terminal their output still
shows. A new check fails the build if any future helper could open a window.

## 0.2.2

Model and effort are compared by exact version, never by family. Before, a session on Opus 5.5 lit both
"Opus 5.5" and "Opus 5" on the phone; switching to Opus 5 could pick Opus 5.5 and report success; moving
from Opus 5 to Opus 5.5 skipped the confirm dialog; and a change to High effort that never landed passed as
"Extra high".

## 0.2.1

The 0.2.0 macOS builds did not pass their checks, so 0.2.0 shipped for Windows only. 0.2.1 fixes that and adds
the macOS downloads. Also fixed: account sync now copies a record's modified time exactly on macOS and Linux
(before, it could differ by under a millisecond from the source).

## What's new in 0.2

- **Goal chaser** — goals with owners, checks and due dates; a session that stopped early is nudged, and a
  "done" waits for your verification. **Cache keeper** — nudges land inside a session's 1-hour prompt cache.
- **Board + inbox** — everything that needs you on one screen; tap several answers and send them in one batch.
- **Project index** — transcripts read into the index incrementally: pending and buried questions, fleet tree,
  context size; routing that learns from your corrections.
- **Context hygiene** — which sessions should compact, write state first, rotate or be archived; optional safe
  auto-compact. Archive candidates now come with reasons.
- **Session overviews and roles** — optional, through an engine you choose (off by default).
- **Accounts** — safer sync (group folding opt-in, a fresh check that Claude is closed inside the lock), a check
  after Claude restarts, Gateway-mode groups, undo.
- **Backup alerts** via ntfy, a webhook or a local command; **finish-the-task hook** (optional).
- **Fixes:** web push was rejected by push services; `baton stop <task-id>` stopped the whole daemon; "This
  computer only" also listened on the Tailscale address; the session drawer's icons spilled onto the main screen
  on phones.

## Downloads

| File | For |
|---|---|
| `Baton-Setup-<version>-x64.exe` | **Windows 10/11 installer (recommended).** Installs for your user only and needs no admin rights. |
| `Baton-<version>-win-x64-portable.zip` | Windows without installing. Unzip it, then run `start-baton.cmd` (or `baton.cmd setup`). |
| `Baton-<version>-arm64.dmg` | macOS on Apple Silicon (M1 and newer). **Untested, see below.** |
| `Baton-<version>-x64.dmg` | macOS on Intel. **Untested, see below.** |
| `Baton-<version>-macos-<arch>-portable.tar.gz` | macOS without the app bundle. Run `./baton setup`. |
| `SHA256SUMS.txt` | Checksums for every file above. |

You also need **Claude Desktop**, installed and signed in: https://claude.ai/download

## Windows

1. Run `Baton-Setup-<version>-x64.exe`. Windows SmartScreen may say the publisher is unknown, because the installer is not code-signed. Click **More info › Run anyway**.
2. Leave both boxes on the last page ticked:
   - **Start Baton when I sign in** starts Baton and its tray icon when you log in.
   - **Run first-time setup** checks Claude Desktop, turns on its **Developer Mode** and **main-process debugger** (Baton needs the debugger to send messages and resume sessions), registers Baton's tools with Claude Code, and opens Baton.
3. If setup had to turn Developer Mode on, quit Claude Desktop (tray icon › Quit) and open it again. Baton then switches the debugger on by itself the next time you are away from the keyboard. You can also run **Baton — Status** from the Start menu, or `baton debugger`.
4. To connect your phone, use **Start menu › Baton — Pair a phone** and scan the QR code.

The installer adds a `baton` command to your PATH (open a new terminal to use it). Uninstall from **Settings › Apps**. Uninstalling stops Baton and removes its autostart and its Claude Code tool registration. It keeps your settings and pairing key in `%USERPROFILE%\.baton`; delete that folder yourself if you no longer want them.

## macOS: untested

**We have not tested the macOS builds on a real Mac.** CI builds them, mounts the DMG and runs the bundled CLI, and that is all. Please open an issue if something does not work. The Windows-only extras (tray icon, sign-in autostart, automatic debugger switch-on) are not available on macOS.

The app is **not signed or notarized**, so macOS blocks the first launch:

1. Drag **Baton.app** into **Applications**.
2. Open it once. When macOS refuses:
   - macOS 14 and older: right-click Baton.app, choose **Open**, then click **Open**.
   - macOS 15 and newer: go to **System Settings › Privacy & Security** and click **Open Anyway**.
   - Or in Terminal: `xattr -dr com.apple.quarantine /Applications/Baton.app`
3. The first launch runs setup: it turns on Claude Desktop's Developer Mode and opens Baton. Quit and reopen Claude Desktop, then choose **Developer › Enable Main Process Debugger** in Claude Desktop's menu.

The command line is inside the app: `/Applications/Baton.app/Contents/Resources/app/baton status`. The launcher writes its log to `~/.baton/state/launcher.log`.

## Checking a download

On Windows: `certutil -hashfile <file> SHA256`. On macOS: `shasum -a 256 <file>`. Compare the result with `SHA256SUMS.txt`.
