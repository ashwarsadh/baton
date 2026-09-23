'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

const Baton = require('./config').DATA;
const PORT = require('./config').get().port;
const CDP_PORT = require('./config').get().cdpPort;
const SCRIPTS = path.join(require('./config').ROOT, 'scripts');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpJson(url, timeoutMs = 6000) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let s = ''; res.on('data', c => s += c);
      res.on('end', () => { try { resolve({ ok: true, body: JSON.parse(s) }); } catch { resolve({ ok: false, error: 'bad json' }); } });
    });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function confirmWedged(log) {
  const first = await checkDaemon();
  if (first.healthy) return first;
  if (log) log.push(`daemon missed one health check (${first.detail}) — re-checking before touching it`);
  await sleep(4000);
  const second = await checkDaemon();
  if (second.healthy && log) log.push('daemon answered on the second check — it was busy, not wedged; leaving it alone');
  return second;
}

const DAEMON_HEALTH_TIMEOUT_MS = Number(process.env.BATON_HEAL_HEALTH_TIMEOUT_MS ?? 25000);

async function checkDaemon() {
  const r = await httpJson(`http://127.0.0.1:${PORT}/api/health`, DAEMON_HEALTH_TIMEOUT_MS);
  return r.ok && r.body && r.body.ok
    ? { name: 'daemon', healthy: true, detail: `up on ${PORT} (pid ${r.body.pid}, uptime ${r.body.uptimeSec}s)` }
    : { name: 'daemon', healthy: false, detail: `not responding on ${PORT}: ${r.error || 'unhealthy'}`, fixable: true };
}

async function checkCdp() {
  const r = await httpJson(`http://127.0.0.1:${CDP_PORT}/json`, 4000);
  return r.ok
    ? { name: 'cdp', healthy: true, detail: `Claude main-process debugger up on ${CDP_PORT}` }
    : { name: 'cdp', healthy: false, detail: `debugger not reachable on ${CDP_PORT}: ${r.error}`, fixable: true };
}

function checkAuth() {
  let bin;
  try { bin = require('./worker').claudeBin(); }
  catch (e) { return { name: 'auth', healthy: false, detail: 'claude CLI not found: ' + e.message, fixable: false }; }

  const workerEnv = { ...process.env, CLAUDE_CONFIG_DIR: require('./config').AUTH };
  delete workerEnv.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
  delete workerEnv.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH;

  let statusRaw = null;
  try {
    statusRaw = execFileSync(bin, ['auth', 'status'],
      { timeout: 45000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: workerEnv });
  } catch (e) { statusRaw = (e && e.stdout) ? String(e.stdout) : null; }

  try {
    const st = statusRaw ? JSON.parse(statusRaw) : null;
    if (st && st.loggedIn === false) {
      return {
        name: 'auth', healthy: false, fixable: false, needsHuman: true,
        detail: `The CLI is NOT logged in (authMethod: ${st.authMethod || 'none'}). Claude Desktop being signed in is a SEPARATE credential store and does not help — every Baton worker spawns the standalone CLI, so all of them fail with 0 tokens.`,
        remedy: 'Run `claude auth login` in a terminal and complete the browser sign-in. Baton cannot do this for you and must never handle your credentials.',
        credentialsFile: path.join(require('./config').CLAUDE_HOME, '.credentials.json'),
      };
    }
    if (st && st.loggedIn) return { name: 'auth', healthy: true, detail: `CLI logged in (${st.authMethod || 'oauth'}, ${st.apiProvider || 'firstParty'})` };
  } catch { }

  if (process.env.ANTHROPIC_API_KEY) {
    return { name: 'auth', healthy: false, needsHuman: true, fixable: false,
             detail: 'ANTHROPIC_API_KEY is set — workers would bill the PAID API instead of the Max subscription. Unset it.' };
  }
  let raw = null;
  try {
    raw = execFileSync(bin, ['-p', 'ok', '--model', 'haiku', '--effort', 'low',
      '--output-format', 'json', '--permission-mode', 'bypassPermissions'],
      { timeout: 90000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    raw = (e && e.stdout) ? String(e.stdout) : null;
    if (!raw) {
      return { name: 'auth', healthy: false, fixable: false,
               detail: 'auth probe produced no output: ' + String(e.message || '').slice(0, 140) };
    }
  }

  let j = null;
  try { j = JSON.parse(raw); } catch {
    return { name: 'auth', healthy: false, fixable: false, detail: 'auth probe output was not JSON: ' + raw.slice(0, 140) };
  }

  if (j.is_error || (j.usage && j.usage.input_tokens === 0 && j.usage.output_tokens === 0)) {
    const msg = String(j.result || j.error || '') + ' ' + String(raw).slice(0, 400);
    const expired = /authenticat|oauth|expired|log ?in|sign ?in|unauthor/i.test(msg);
    return {
      name: 'auth', healthy: false, fixable: false, needsHuman: expired,
      detail: expired
        ? 'OAuth session EXPIRED — every worker fails with 0 tokens until you sign in again. This is almost certainly why tasks started failing.'
        : 'CLI returned an error: ' + String(j.result || '').slice(0, 160),
      remedy: expired
        ? 'Sign in again in Claude Desktop (or run `claude` in a terminal and complete the login). Baton cannot do this for you and must never handle your credentials.'
        : undefined,
    };
  }
  return { name: 'auth', healthy: true, detail: `OAuth subscription auth working (${j.usage.output_tokens} output tokens)` };
}

function checkRegistry() {
  try {
    const registry = require('./registry');
    const all = registry.allTasks();
    const stuck = all.filter(t => t.status === 'running');
    return {
      name: 'registry', healthy: true,
      detail: `${all.length} task(s) tracked; ${stuck.length} marked running`,
      stuckCount: stuck.length,
    };
  } catch (e) {
    return { name: 'registry', healthy: false, fixable: false, detail: 'registry unreadable: ' + e.message };
  }
}

function checkScheduledTask() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '$t=Get-ScheduledTask -TaskName "Baton" -EA SilentlyContinue; $i=Get-ScheduledTaskInfo -TaskName "Baton" -EA SilentlyContinue; if($t){"$($t.State)|$($i.LastTaskResult)"}else{"MISSING|"}'],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' }).trim();
    const [state, lastResult] = out.split('|');
    if (state === 'MISSING') return { name: 'scheduledTask', healthy: false, fixable: false, detail: 'task "Baton" is not registered (needs elevation to create)' };
    return { name: 'scheduledTask', healthy: true, detail: `state=${state} lastResult=${lastResult}`, state, lastResult };
  } catch (e) {
    return { name: 'scheduledTask', healthy: false, fixable: false, detail: 'could not query task: ' + e.message };
  }
}

function portHolder(port) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | Select-Object -First 1).OwningProcess`],
      { timeout: 20000, windowsHide: true, encoding: 'utf8' }).trim();
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

// Only ever kill Baton's own daemon: the port may be held by an unrelated program.
function isBatonProcess(pid) {
  try {
    const cmd = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
          { timeout: 20000, windowsHide: true, encoding: 'utf8' })
      : execFileSync('ps', ['-o', 'command=', '-p', String(Number(pid))], { timeout: 5000, encoding: 'utf8' });
    const norm = x => x.split(path.sep).join('/').toLowerCase();
    return norm(cmd).includes(norm(path.join(require('./config').ROOT, 'server.js')));
  } catch { return false; }
}

function killPid(pid) {
  if (!isBatonProcess(pid)) return false;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20000, windowsHide: true, stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGKILL');
    return true;
  } catch { return false; }
}

async function repairDaemon(log) {
  const holder = portHolder(PORT);
  if (holder) {
    const h = await confirmWedged(log);
    if (!h.healthy) {
      log.push(`port ${PORT} is held by pid ${holder} but it fails health checks — wedged; evicting it`);
      if (killPid(holder)) { log.push(`killed wedged holder pid ${holder}`); await sleep(2000); }
      else log.push(`did not kill pid ${holder} (not Baton's own daemon, or needs elevation) — free port ${PORT} or change it in Settings`);
    }
  }

  try {
    execFileSync('powershell', ['-NoProfile', '-Command', 'Stop-ScheduledTask -TaskName "Baton" -EA SilentlyContinue'],
      { timeout: 30000, windowsHide: true });
    log.push('stopped any existing (possibly zombie) scheduled-task instance');
  } catch {}
  await sleep(2500);

  try {
    execFileSync('powershell', ['-NoProfile', '-Command', 'Start-ScheduledTask -TaskName "Baton"'],
      { timeout: 30000, windowsHide: true });
    log.push('started the Baton scheduled task');
  } catch (e) {
    log.push('scheduled task start failed: ' + e.message.slice(0, 80));
  }

  for (let i = 0; i < 8; i++) {
    await sleep(2000);
    const r = await checkDaemon();
    if (r.healthy) { log.push('daemon confirmed healthy via scheduled task: ' + r.detail); return true; }
  }

  log.push('task did not yield a live daemon (it can report success while the process exits) — spawning server.js directly');
  try {
    const child = require('child_process').spawn(process.execPath, [path.join(require('./config').ROOT, 'server.js')],
      { detached: true, windowsHide: true, stdio: 'ignore', cwd: require('os').homedir() });
    child.unref();
    log.push('spawned server.js directly (pid ' + child.pid + ')');
  } catch (e2) { log.push('direct spawn failed: ' + e2.message); return false; }

  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const r = await checkDaemon();
    if (r.healthy) { log.push('daemon confirmed healthy after direct spawn: ' + r.detail); return true; }
  }
  log.push('daemon still not responding after both strategies');
  return false;
}

async function repairCdp(log) {
  const macro = path.join(SCRIPTS, 'enable-debugger.ps1');
  if (!fs.existsSync(macro)) { log.push('enable-debugger.ps1 not found — cannot re-enable the debugger'); return false; }
  try {
    await new Promise(resolve => {
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', macro, '-Port', String(require('./config').get().cdpPort)],
        { timeout: 120000, windowsHide: true }, () => resolve());
    });
    log.push('ran enable-debugger.ps1');
  } catch (e) { log.push('enable-debugger.ps1 failed: ' + e.message.slice(0, 100)); }
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    const r = await checkCdp();
    if (r.healthy) { log.push('debugger confirmed up'); return true; }
  }
  log.push('debugger still down — it may need the Claude window in the foreground');
  return false;
}

function repairStuckTasks(log) {
  try {
    const worker = require('./worker');
    const r = worker.reconcile();
    log.push(`reconciled tasks: ${r.recovered} completed-while-down, ${r.failed} failed, ${r.stillRunning} genuinely running`);
    return true;
  } catch (e) { log.push('reconcile failed: ' + e.message); return false; }
}

async function heal(opts = {}) {
  const repair = opts.repair !== false;
  const log = [];
  const checks = [];

  checks.push(await checkCdp());
  const daemonCheck = await checkDaemon();
  checks.push(daemonCheck);
  const taskCheck = checkScheduledTask();
  if (taskCheck.healthy && taskCheck.state === 'Running' && !daemonCheck.healthy) {
    taskCheck.healthy = false;
    taskCheck.fixable = true;
    taskCheck.detail = `ZOMBIE: task state=Running but nothing is listening on ${PORT}. IgnoreNew means the 10-minute watchdog is blocked and the daemon will not come back by itself. (lastResult=${taskCheck.lastResult})`;
  }
  checks.push(taskCheck);
  checks.push(checkRegistry());
  if (!opts.skipAuth) checks.push(checkAuth());

  if (repair) {
    const cdp = checks.find(c => c.name === 'cdp');
    if (cdp && !cdp.healthy) { await repairCdp(log); }

    const daemon = checks.find(c => c.name === 'daemon');
    if (daemon && !daemon.healthy) { await repairDaemon(log); }

    const reg = checks.find(c => c.name === 'registry');
    if (reg && reg.stuckCount > 0) { repairStuckTasks(log); }

    const after = [await checkCdp(), await checkDaemon(), checkScheduledTask(), checkRegistry()];
    if (!opts.skipAuth) after.push(checks.find(c => c.name === 'auth'));
    for (const a of after) {
      const i = checks.findIndex(c => c.name === a.name);
      if (i >= 0 && a) checks[i] = a;
    }
  }

  const broken = checks.filter(c => !c.healthy);
  const needsHuman = broken.filter(c => c.needsHuman);
  return {
    healthy: broken.length === 0,
    status: broken.length === 0 ? 'HEALTHY'
      : needsHuman.length ? 'NEEDS_HUMAN'
      : 'DEGRADED',
    checks,
    repairsAttempted: repair ? log : ['(diagnosis only — repair was not requested)'],
    blockedOn: needsHuman.map(c => ({ check: c.name, detail: c.detail, remedy: c.remedy })),
    summary: broken.length === 0
      ? 'Baton is fully operational.'
      : `${broken.length} problem(s): ${broken.map(c => c.name).join(', ')}` +
        (needsHuman.length ? ' — at least one needs the user and cannot be repaired automatically.' : ''),
  };
}

module.exports = { heal, repairCdp, checkDaemon, checkCdp, checkAuth, checkRegistry, checkScheduledTask, portHolder, killPid, isBatonProcess };
