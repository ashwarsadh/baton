// ostasks.js — the operating system's scheduled tasks, each attributed to the project that owns it.
//
// This is how a machine-level symptom ("a console window keeps flashing", "something runs every
// hour") gets routed to the session that owns the cause. Windows: `schtasks /Query /FO CSV /V`
// (Microsoft's own tasks skipped). macOS: ~/Library/LaunchAgents/*.plist plus `crontab -l`, best
// effort. Linux: `crontab -l`, best effort.
//
// Owner attribution: settings.index.taskOwners { "<path prefix>": "<project>" } first, then the
// known project roots from the index — the longest path contained in the task's command wins.
// The inventory is cached in <data>/conductor/os-tasks.json; refreshing it spawns a process, so it
// only runs when the osTasks module is on, or when asked for explicitly.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');

const CACHE = () => path.join(config.DATA, 'conductor', 'os-tasks.json');
const HIDDEN_RX = /pythonw\.exe|wscript\.exe\s+\/\/B|cscript\.exe\s+\/\/B|-WindowStyle\s+Hidden|\.vbs\b/i;
const CONSOLE_RX = /\b(cmd\.exe|cmd|node\.exe|node|python\.exe|python|powershell\.exe|powershell|pwsh|cscript\.exe|wscript\.exe|\.cmd|\.bat)\b/i;

/** Minimal RFC-4180 CSV parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function firesOf(stype, repeat, status) {
  if (/on demand/i.test(stype) || status === 'Disabled') return 'never';
  if (repeat && repeat !== 'N/A' && !/disabled/i.test(repeat)) return 'recurring';
  if (/logon|start ?up|boot/i.test(stype)) return 'logon';
  return 'daily';
}

/** schtasks /V CSV -> rows (repeated header rows and \Microsoft\ tasks dropped). */
function parseSchtasksCsv(text) {
  const rows = parseCsv(text);
  let hdr = null;
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (r[0] === 'HostName' || r.includes('TaskName')) { hdr = r; continue; }
    if (!hdr) continue;
    const o = {}; hdr.forEach((h, i) => { o[h] = r[i]; });
    const name = o.TaskName || '', act = o['Task To Run'] || '';
    if (!name || seen.has(name) || /^\\Microsoft\\/i.test(name) || !act || act === 'N/A') continue;
    seen.add(name);
    const status = o.Status || '', runAs = o['Run As User'] || '', stype = o['Schedule Type'] || '', repeat = o['Repeat: Every'] || '';
    const fires = firesOf(stype, repeat, status);
    const hidden = HIDDEN_RX.test(act);
    out.push({ name: name.replace(/^\\/, ''), status, schedule: (stype + ' ' + repeat).trim(), fires, run_as: runAs,
      action: act.slice(0, 300), source: 'schtasks',
      // a console can only be SEEN if the task fires on its own, in the user's session, without a hidden wrapper
      console: CONSOLE_RX.test(act) && !hidden && fires !== 'never' && !/^(SYSTEM|USERS|INTERACTIVE)$/i.test(runAs),
      last_run: o['Last Run Time'] || null, last_result: o['Last Result'] || null });
  }
  return out;
}

/** crontab -l -> rows. */
function parseCrontab(text) {
  const out = [];
  for (const ln of String(text || '').split('\n')) {
    const t = ln.trim();
    if (!t || t.startsWith('#') || /^[A-Z_]+=/.test(t)) continue;
    const m = /^(@\w+|(?:\S+\s+){4}\S+)\s+(.+)$/.exec(t);
    if (!m) continue;
    out.push({ name: 'cron: ' + m[2].slice(0, 60), status: 'Ready', schedule: m[1], fires: m[1] === '@reboot' ? 'logon' : 'recurring',
      run_as: os.userInfo().username, action: m[2].slice(0, 300), source: 'crontab', console: false, last_run: null, last_result: null });
  }
  return out;
}

/** A launchd plist (XML) -> row, regex-parsed (no plist library). */
function parsePlist(text, file) {
  const s = String(text || '');
  const key = k => { const m = new RegExp('<key>' + k + '</key>\\s*<(string|integer|true|false)\\s*/?>([^<]*)').exec(s); return m ? (m[1] === 'true' ? true : m[1] === 'false' ? false : m[2]) : null; };
  const label = key('Label') || path.basename(file || '', '.plist');
  const argsM = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(s);
  const args = argsM ? [...argsM[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]) : [];
  const action = (args.length ? args.join(' ') : key('Program') || '').slice(0, 300);
  const interval = key('StartInterval');
  const cal = /<key>StartCalendarInterval<\/key>/.test(s);
  const atLoad = key('RunAtLoad') === true;
  const disabled = key('Disabled') === true;
  return { name: label, status: disabled ? 'Disabled' : 'Ready', schedule: interval ? `every ${interval}s` : cal ? 'calendar' : atLoad ? 'at load' : 'on demand',
    fires: disabled ? 'never' : interval || cal ? 'recurring' : atLoad ? 'logon' : 'never', run_as: os.userInfo().username,
    action, source: 'launchd', console: false, last_run: null, last_result: null };
}

/** Attribute each row to an owner project: explicit map first, then project roots; longest prefix wins. */
function attribute(rows, projectRoots = [], map = (config.get().index || {}).taskOwners || {}) {
  const owners = [];
  for (const [p, name] of Object.entries(map || {})) if (p && name) owners.push([String(p).toLowerCase().replace(/[\\/]+$/, ''), String(name)]);
  for (const r of projectRoots) if (r && r.path && r.name) owners.push([String(r.path).toLowerCase().replace(/[\\/]+$/, ''), r.name]);
  owners.sort((a, b) => b[0].length - a[0].length);
  const norm = s => String(s || '').toLowerCase().replace(/\//g, '\\');
  for (const t of rows) {
    const act = String(t.action || '').toLowerCase(), actN = norm(t.action);
    const hit = owners.find(([p]) => act.includes(p) || actN.includes(norm(p)));
    t.owner = hit ? hit[1] : null;
  }
  const order = { recurring: 0, logon: 1, daily: 2, never: 3 };
  return rows.sort((a, b) => (b.console - a.console) || ((order[a.fires] ?? 9) - (order[b.fires] ?? 9)) || a.name.localeCompare(b.name));
}

const run = (cmd, args, timeout = 60000) => new Promise(resolve => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 32 << 20, encoding: 'utf8' }, (err, stdout) => resolve(err && !stdout ? { error: err.message } : { stdout: stdout || '' }));
});

/** Read the OS inventory now. Never throws: an error becomes one { error } row. */
async function readNow() {
  if (process.platform === 'win32') {
    const r = await run('schtasks', ['/Query', '/FO', 'CSV', '/V']);
    return r.error ? [{ error: r.error }] : parseSchtasksCsv(r.stdout);
  }
  const rows = [];
  if (process.platform === 'darwin') {
    const d = path.join(os.homedir(), 'Library', 'LaunchAgents');
    let names = [];
    try { names = fs.readdirSync(d).filter(n => n.endsWith('.plist')); } catch {}
    for (const n of names) { try { rows.push(parsePlist(fs.readFileSync(path.join(d, n), 'utf8'), n)); } catch {} }
  }
  const c = await run('crontab', ['-l'], 10000);
  if (c.stdout) rows.push(...parseCrontab(c.stdout));
  return rows;
}

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE(), 'utf8')); } catch { return null; } }

/** The inventory, refreshed when older than maxAgeMs (or force). `reader` is injectable for tests. */
async function collect({ maxAgeMs = 6 * 3600000, force = false, projectRoots = [], reader = readNow } = {}) {
  const c = readCache();
  let rows, at;
  if (!force && c && Date.now() - Date.parse(c.at || 0) < maxAgeMs) { rows = c.rows; at = c.at; }
  else {
    rows = await reader();
    at = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(CACHE()), { recursive: true });
      fs.writeFileSync(CACHE(), JSON.stringify({ at, platform: process.platform, rows }));
    } catch {}
  }
  const good = rows.filter(r => !r.error);
  return { at, rows: attribute(good, projectRoots).concat(rows.filter(r => r.error)) };
}

module.exports = { parseCsv, parseSchtasksCsv, parseCrontab, parsePlist, attribute, collect, readNow, readCache, CACHE };
