'use strict';
// follow-claude.js: "start Baton when Claude starts, stop it after exit (after syncing the sessions)".
// Guards the stop decision with fakes, and that the tray starts it only while Desktop is open.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { makeFollow, GONE_MS } = require(path.join(root, 'lib', 'follow.js'));
const config = require(path.join(root, 'lib', 'config.js'));
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };

function rig(o = {}) {
  const s = { t: 0, up: o.up ?? true, busy: null, synced: 0, stopped: 0, log: [], upAfterSync: false };
  const f = makeFollow({
    enabled: () => o.enabled ?? true, now: () => s.t,
    claudeUp: async () => s.up, busy: () => s.busy,
    sync: async () => { s.synced++; if (s.upAfterSync) s.up = true; return 'synced'; },
    stop: () => { s.stopped++; }, log: m => s.log.push(m),
  });
  return { s, f };
}

(async () => {
  ok(config.DEFAULTS.followClaude === false, 'off by default');
  {
    const { s, f } = rig({ up: false });
    for (let i = 0; i < 5; i++) { s.t += 5000; await f.tick(); }
    ok(s.stopped === 0 && s.synced === 0, 'a Baton started with Desktop closed stays up');
  }
  {
    const { s, f } = rig();
    await f.tick(); s.up = false;
    await f.tick(); s.t += GONE_MS - 1; await f.tick();
    ok(s.stopped === 0, 'a Desktop gone for less than 10 s (an update restart) does not stop Baton');
    s.up = true; await f.tick(); s.up = false; await f.tick(); s.t += GONE_MS; await f.tick();
    ok(s.stopped === 1 && s.synced === 1, 'Desktop seen, then gone 10 s: the sync runs, then Baton stops');
    ok(s.log.some(m => /exit sync: synced/.test(m)), 'the sync result is logged');
  }
  {
    const { s, f } = rig();
    await f.tick(); s.up = false; s.busy = '1 Baton task(s) running';
    await f.tick(); s.t += GONE_MS; await f.tick(); await f.tick();
    ok(s.stopped === 0 && s.synced === 0 && s.log.filter(m => /waiting to stop/.test(m)).length === 1, 'a running task holds the stop (logged once)');
    s.busy = null; await f.tick();
    ok(s.stopped === 1, 'it stops once the task is done');
  }
  {
    const { s, f } = rig();
    await f.tick(); s.up = false; s.upAfterSync = true;
    await f.tick(); s.t += GONE_MS; await f.tick();
    ok(s.synced === 1 && s.stopped === 0 && s.log.some(m => /back/.test(m)), 'Desktop reopened during the sync: Baton stays up');
  }
  {
    const { s, f } = rig({ enabled: false });
    await f.tick(); s.up = false; await f.tick(); s.t += GONE_MS * 2; await f.tick();
    ok(s.stopped === 0, 'with the setting off nothing stops');
  }
  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  ok(/bootPass\(\{ trigger: 'desktop-exit' \}\)/.test(srv) && /transferTick\(\{ exited: true \}\)/.test(srv) && /shutdown\('follow-claude'\)/.test(srv) && /follow\.tick\(\)/.test(srv), 'the daemon wires the account sync and a clean shutdown');
  const tray = fs.readFileSync(path.join(root, 'scripts', 'tray.ps1'), 'utf8');
  ok(/if \(Wanted\) \{ StartDaemon \}/.test(tray), 'the tray starts Baton at sign-in only when it is wanted');
  ok(tray.indexOf("Baton is asleep - it starts when Claude Desktop opens'; $icon") < tray.indexOf("'Baton stopped - restarting'"), 'the health poll does not restart a Baton that stopped with Desktop');
  ok(/\$follow\.Interval = 3000/.test(tray) && /if \(\$up -and -not \$script:wasUp -and -not \(StoppedByUser\)\) \{ StartDaemon/.test(tray), 'the tray starts Baton within seconds of Desktop opening, never after Quit');
  const ui = fs.readFileSync(path.join(root, 'mobile', 'public', 'settings-ui.js'), 'utf8');
  ok(/toggle\('followClaude'/.test(ui), 'Settings has the switch');
  console.log(`\n${n}/${n} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
