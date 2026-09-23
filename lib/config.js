// config.js — where Baton keeps its data, and the user's settings.
//
// Everything Baton writes lives under ONE directory (default ~/.baton, override with BATON_HOME):
//   settings.json   what the Settings screen edits
//   state/          queue, logs, snapshots, caches
//   mobile/         access token, push keys, sub-users
//   uploads/        files sent from the phone
//   results/        worker results
//   auth/           private Claude config dir for headless workers
//
// Settings are read fresh on every get() (mtime-cached), so a change made in the Settings screen
// takes effect on the next tick without restarting the daemon, except where noted (ports).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ROOT = path.join(__dirname, '..');
const DATA = process.env.BATON_HOME || path.join(HOME, '.baton');
const STATE = process.env.BATON_STATE_DIR || path.join(DATA, 'state');
const MOBILE = path.join(DATA, 'mobile');
const UPLOADS = path.join(DATA, 'uploads');
const RESULTS = path.join(DATA, 'results');
const AUTH = path.join(DATA, 'auth');
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const APPDATA = process.env.APPDATA || (process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support') : process.platform === 'win32' ? path.join(HOME, 'AppData', 'Roaming') : path.join(HOME, '.config'));
const SETTINGS_FILE = path.join(DATA, 'settings.json');

for (const d of [DATA, STATE, MOBILE, UPLOADS, RESULTS]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

// Every key the Settings screen knows about, with its default. Unknown keys in settings.json are
// preserved but ignored.
const DEFAULTS = {
  // Ports. Changing either needs a daemon restart.
  port: 8788,            // control API + dashboard, loopback only
  appPort: 8790,         // the phone/desktop app, token-protected
  appBind: 'auto',       // 'auto' = loopback + Tailscale (if present) + LAN when remote.mode is 'lan'

  cdpPort: 9229,         // Claude Desktop's main-process debugger (Developer > Enable Main Process Debugger)
  autoEnableDebugger: true, // Windows: switch the debugger back on after Claude Desktop restarts (while you are idle)

  modules: {
    app: true,            // phone + desktop web app: sessions, chat, send, model/effort, push
    autoResume: true,     // resume sessions stopped by a usage limit or a Desktop crash
    orchestrator: true,   // master/worker MCP tools: spawn, fleet, goals, await
    chipAutostart: false, // press Start on background-task chips in sessions a master owns
    masterNotify: true,   // wake the master when a worker finishes or asks something
    board: false,         // a tappable to-do board read from a JSON file (see docs/BOARD.md)
    routines: true,       // show Claude Code scheduled tasks in the app
    accounts: false,      // multiple Claude accounts on one machine (experimental)
  },

  // Never drive the Desktop window while you are using the computer. Actions queue until you have
  // been idle this long. 0 disables the gate.
  idleGateSeconds: 15,

  remote: {
    mode: 'off',          // off | lan | tailscale | cloudflare-quick | cloudflare-named
    hostname: '',         // cloudflare-named: e.g. baton.example.com
    tunnelName: 'baton',  // cloudflare-named: tunnel name created in your Cloudflare account
    cloudflaredPath: '',  // blank = find cloudflared on PATH
    access: { team: '', aud: '' }, // optional Cloudflare Access verification (team.cloudflareaccess.com + AUD tag)
  },

  notifications: { enabled: true, awaiting: true, done: true, pushSubject: 'mailto:admin@localhost' },

  workers: {
    concurrency: 3,
    guiConcurrency: 2,
    dispatch: 'auto',     // auto | headless | gui
    defaultModel: 'claude-opus-5-5',
  },

  // Optional integrations; blank = feature hidden.
  board: { dir: '' },     // folder holding board.json (default <data>/board) — see docs/BOARD.md
  conductorSession: '',   // the session id that receives Board taps and master reports (optional)
  ownerIndex: '',         // a directory with an index of which session owns which topic
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

let cache = null, cacheMtime = -1;
function readRaw() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function get() {
  let m = 0; try { m = fs.statSync(SETTINGS_FILE).mtimeMs; } catch {}
  if (cache && m === cacheMtime) return cache;
  cache = merge(DEFAULTS, readRaw()); cacheMtime = m;
  // Environment overrides win (useful for tests and service managers).
  if (process.env.BATON_PORT) cache.port = Number(process.env.BATON_PORT);
  if (process.env.BATON_APP_PORT) cache.appPort = Number(process.env.BATON_APP_PORT);
  if (process.env.BATON_CDP_PORT) cache.cdpPort = Number(process.env.BATON_CDP_PORT);
  return cache;
}
/** Deep-merge a patch into settings.json and return the new effective settings. */
function set(patch) {
  const next = merge(readRaw(), patch || {});
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  cache = null;
  return get();
}
const mod = name => !!(get().modules || {})[name];

module.exports = {
  HOME, ROOT, DATA, STATE, MOBILE, UPLOADS, RESULTS, AUTH, CLAUDE_HOME, APPDATA, SETTINGS_FILE,
  DEFAULTS, get, set, mod,
};
