// launch.js — the ONE way Baton starts its daemon in the background, so every start path keeps what
// node says when it dies.
//
// A heap-limit abort, a native fault and an out-of-memory message all report on STDERR, and a daemon
// started with stderr discarded dies without a trace. So every background start goes through a small
// wrapper (scripts/run-daemon.cmd on Windows, scripts/run-daemon.sh elsewhere) that:
//   - rotates state/daemon-stdio.log at 10 MB (one generation kept) BEFORE node starts — a shell
//     redirect holds the file open, so it cannot be rotated under a running process;
//   - writes one "launching" line, appends node's STDERR only, then one "exited with code N" line.
// Stdout is not captured: the daemon's own log (state/baton.log) already records it, and copying it
// would make the capture grow as fast as that log, so "there are bytes in here" would mean nothing.
// A healthy daemon leaves this file almost empty; its SIZE is the signal.
//
// Callers: `baton start`, `baton restart`, `baton open`, heal's direct-spawn repair, and (through the
// same .cmd) the tray's StartDaemon and the autostart tasks.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_BYTES = 10 * 1024 * 1024;

function stateDir() { return process.env.BATON_STATE_DIR || require('./config').STATE; }
function logFile() { return path.join(stateDir(), 'daemon-stdio.log'); }

/** Rotate `file` to `file.1` when it is larger than `max` bytes. Returns true if it rotated. */
function rotate(file, max = MAX_BYTES) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= max) return false;
  try { fs.unlinkSync(file + '.1'); } catch {}
  try { fs.renameSync(file, file + '.1'); return true; } catch { return false; }
}

function wrapper() {
  const root = require('./config').ROOT;
  return process.platform === 'win32'
    ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', path.join(root, 'scripts', 'run-daemon.cmd')] }
    : { cmd: '/bin/sh', args: [path.join(root, 'scripts', 'run-daemon.sh')] };
}

/**
 * Start the daemon detached through the wrapper. `entry` (default server.js) exists for tests.
 * Returns { pid, log, wrapper }.
 */
function spawnDaemon(opts = {}) {
  const log = logFile();
  try { fs.mkdirSync(path.dirname(log), { recursive: true }); } catch {}
  const w = wrapper();
  const env = { ...process.env, BATON_NODE: opts.node || process.execPath };
  if (opts.entry) env.BATON_DAEMON_ENTRY = opts.entry;
  const child = spawn(w.cmd, w.args, {
    detached: true, stdio: 'ignore', windowsHide: true, env,
    cwd: opts.cwd || require('os').homedir(),
  });
  child.unref();
  return { pid: child.pid, log, wrapper: w.args[w.args.length - 1] };
}

/**
 * The same wrapper, run in the FOREGROUND and awaited — for tests and for a service manager
 * (systemd / launchd) that wants to supervise the process itself.
 */
function runWrapped(opts = {}) {
  const w = wrapper();
  const env = { ...process.env, BATON_NODE: opts.node || process.execPath };
  if (opts.entry) env.BATON_DAEMON_ENTRY = opts.entry;
  return new Promise(resolve => {
    const child = spawn(w.cmd, w.args, { stdio: 'ignore', windowsHide: true, env });
    child.on('exit', code => resolve(code));
    child.on('error', () => resolve(null));
  });
}

// "The user stopped Baton" marker. The tray's health poll and the 10-minute watchdog both restart a
// missing daemon; without this they would undo `baton stop` and the tray's Quit within minutes.
function stopMarker() { return path.join(stateDir(), 'stopped-by-user.json'); }
function markStopped(by) {
  try { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(stopMarker(), JSON.stringify({ at: new Date().toISOString(), by: by || 'cli' })); return true; }
  catch { return false; }
}
function clearStopped() { try { fs.unlinkSync(stopMarker()); return true; } catch { return false; } }
function stoppedByUser() { try { return JSON.parse(fs.readFileSync(stopMarker(), 'utf8')); } catch { return null; } }

module.exports = { spawnDaemon, runWrapped, rotate, logFile, wrapper, MAX_BYTES, markStopped, clearStopped, stoppedByUser, stopMarker };
