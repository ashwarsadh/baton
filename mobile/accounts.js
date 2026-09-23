'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const PROFILE = path.join(require('../lib/config').APPDATA, 'Claude');
const CONFIG = path.join(PROFILE, 'claude_desktop_config.json');
const SESSIONS_ROOT = path.join(PROFILE, 'claude-code-sessions');
const MIGRATE_DIR = path.join(require('../lib/config').CLAUDE_HOME, 'migrate');
const WATCHER = path.join(MIGRATE_DIR, 'apply-on-exit.ps1');
const LABELS = path.join(MIGRATE_DIR, 'account-labels.json');
const WATCH_ROOT = path.join(require('../lib/config').DATA, 'migrate');
const LOG = path.join(WATCH_ROOT, 'apply-on-exit.log');
const DONE = path.join(WATCH_ROOT, 'apply-on-exit.DONE');

const isRec = f => /^local_.*\.json$/.test(f);

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS, 'utf8')); } catch { return {}; }
}

function readCliAccount() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || '', '.claude.json'), 'utf8'));
    const o = j.oauthAccount;
    if (!o || !o.accountUuid) return null;
    return {
      scope: `${o.accountUuid}/${o.organizationUuid}`,
      account: o.accountUuid,
      email: o.emailAddress || null,
    };
  } catch { return null; }
}

function learnLabel(active) {
  if (!active || !active.email) return;
  const labels = readLabels();
  if (labels[active.account] === active.email) return;
  labels[active.account] = active.email;
  try {
    fs.mkdirSync(MIGRATE_DIR, { recursive: true });
    fs.writeFileSync(LABELS, JSON.stringify(labels, null, 2));
  } catch {}
}

function groupScopes() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    let s = cfg.preferences && cfg.preferences.epitaxyPrefs &&
            cfg.preferences.epitaxyPrefs['dframe-group-scopes'];
    if (typeof s === 'string') s = JSON.parse(s);
    return (s && typeof s === 'object') ? s : {};
  } catch { return {}; }
}

function countGroups(o) {
  if (!o) return { groups: 0, assignments: 0 };
  const groups = (o.groups || o.customGroups || []).length;
  const a = o.assignments || o.groupBySession || {};
  return { groups, assignments: (a && typeof a === 'object') ? Object.keys(a).length : 0 };
}

function scanScopes() {
  const out = [];
  let accounts = [];
  try { accounts = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()); }
  catch { return out; }
  const scopes = groupScopes();
  const labels = readLabels();
  for (const a of accounts) {
    let orgs = [];
    try { orgs = fs.readdirSync(path.join(SESSIONS_ROOT, a.name), { withFileTypes: true }).filter(d => d.isDirectory()); }
    catch { continue; }
    for (const o of orgs) {
      const dir = path.join(SESSIONS_ROOT, a.name, o.name);
      let files = [];
      try { files = fs.readdirSync(dir).filter(isRec); } catch {}
      let newest = 0, archived = 0;
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch {}
      }
      if (files.length && files.length <= 1200) {
        archived = 0;
        for (const f of files) {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            if (j && (j.isArchived === true || j.archived === true)) archived++;
          } catch {}
        }
      } else archived = null;
      const key = `${a.name}/${o.name}`;
      out.push({
        scope: key,
        account: a.name,
        org: o.name,
        label: labels[a.name] || null,
        records: files.length,
        archived,
        newestMs: newest,
        newest: newest ? new Date(newest).toISOString() : null,
        ...countGroups(scopes[key]),
      });
    }
  }
  out.sort((x, y) => y.records - x.records || y.newestMs - x.newestMs);
  const cli = readCliAccount();
  let newestScope = null, newestMs = 0;
  for (const s of out) if (s.records && s.newestMs > newestMs) { newestMs = s.newestMs; newestScope = s.scope; }
  for (const s of out) {
    s.desktopActive = s.scope === newestScope;
    s.cliActive = !!(cli && s.scope === cli.scope);
    s.active = s.desktopActive;
    if (s.cliActive && cli.email) s.label = cli.email;
  }
  return out;
}

function desktopRunning() {
  try {
    const ps = "(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | " +
      "Where-Object { $_.ExecutablePath -like '*WindowsApps\\Claude_*' -or $_.ExecutablePath -like '*AnthropicClaude*' } | " +
      "Measure-Object).Count";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    return parseInt(out.trim(), 10) > 0;
  } catch { return null; }
}

function watcherRunning() {
  try {
    const ps = "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*-File*apply-on-exit.ps1*' -and " +
      "$_.CommandLine -notlike '*Get-CimInstance*' -and $_.ProcessId -ne $PID } | Measure-Object).Count";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    return parseInt(out.trim(), 10) > 0;
  } catch { return null; }
}

function tailLog(n = 8) {
  try {
    return fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/).slice(-n);
  } catch { return []; }
}

function scopeGuardStatus() {
  try {
    const g = require(path.join(MIGRATE_DIR, 'scope-guard.js'));
    return { ok: true, lines: g.run('check', []) };
  } catch (e) { return { ok: false, error: e.message }; }
}

function guardTaskRunning() {
  try {
    const ps = "(Get-ScheduledTask -TaskName 'ClaudeProfileGuard' -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.State -ne 'Disabled' } | Measure-Object).Count";
    return parseInt(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim(), 10) > 0;
  } catch { return null; }
}

function readAccounts() {
  const cli = readCliAccount();
  learnLabel(cli);
  const scopes = scanScopes();
  const desktop = scopes.find(s => s.desktopActive) || null;
  return {
    cliAccount: cli,
    desktopAccount: desktop ? { scope: desktop.scope, account: desktop.account, label: desktop.label } : null,
    active: cli,
    scopes,
    desktopRunning: desktopRunning(),
    groupGuard: {
      taskRegistered: guardTaskRunning(),
      status: scopeGuardStatus(),
      savedLogins: (() => {
        try { return require(path.join(MIGRATE_DIR, 'profile-store.js')).list()
          .map(p => ({ account: p.accountUuid, email: p.email, complete: p.complete, savedAt: p.savedAt })); }
        catch { return []; }
      })(),
    },
    migration: {
      armed: watcherRunning(),
      done: fs.existsSync(DONE),
      watcherPresent: fs.existsSync(WATCHER),
      log: tailLog(),
    },
    note: 'cliAccount is the CLI login; desktopAccount is the scope Desktop is writing to. They differ after an in-app account switch.',
  };
}

function armMigration({ from, to }) {
  if (!from || !to) return { ok: false, error: 'from and to scopes are required' };
  if (from === to) return { ok: false, error: 'from and to are the same scope' };
  const known = new Set(scanScopes().map(s => s.scope));
  if (!known.has(from)) return { ok: false, error: 'unknown source scope: ' + from };

  const restoreDir = path.join(require('../lib/config').DATA, 'migrate');
  const script = path.join(restoreDir, 'migrate-to-account.js');
  if (!fs.existsSync(script)) return { ok: false, error: 'migrate-to-account.js not found at ' + script };

  let phase1;
  try {
    phase1 = execFileSync('node', [script, from, to, '--apply', '--records-only'],
      { cwd: restoreDir, encoding: 'utf8' });
  } catch (e) {
    return { ok: false, phase: 'records', error: String((e.stdout || '') + (e.stderr || '') || e.message) };
  }

  try { fs.mkdirSync(MIGRATE_DIR, { recursive: true }); } catch {}
  fs.writeFileSync(path.join(MIGRATE_DIR, 'direction.json'),
    JSON.stringify({ from, to, armedAt: new Date().toISOString() }, null, 2));
  try { fs.rmSync(DONE, { force: true }); } catch {}

  const running = watcherRunning();
  if (running === null) {
    return { ok: false, phase: 'arm', error: 'cannot tell whether a watcher is already running; not starting another', phase1 };
  }
  if (running === false) {
    if (!fs.existsSync(WATCHER)) return { ok: false, phase: 'arm', error: 'watcher script missing: ' + WATCHER, phase1 };
    const child = execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', WATCHER],
      { windowsHide: true }, () => {});
    child.unref();
  }

  return {
    ok: true,
    phase1: phase1.trim().split(/\r?\n/).slice(-6),
    armed: true,
    message: 'Records copied. Group scope will be written the moment Claude Desktop exits.',
  };
}

module.exports = { readAccounts, armMigration };
