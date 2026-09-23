// mobile-cancel.js — cancelling a running turn from the phone, and telling a stuck "Running" status
// apart from real work. Ported from the private tool's test-cancel.js: the stale-status heuristic is
// pure, and the cancel path's REFUSALS are the parts that must never misfire. The live-desktop half
// (unknown id -> not-found, idle session -> not-running without moving the view) needs a real
// Claude Desktop and is skipped here: the debugger port points at nothing.
'use strict';
const H = require('./mobile-harness');
const W = H.world('cancel', { demo: false, env: true });
const { check: chk } = H;

const sessions = require('../mobile/sessions');
const desktop = require('../lib/desktop');
const MIN = 60 * 1000;
const snapOf = (rows) => ({ sessions: rows, groups: [], active: null });
const run = (id) => ({ sessionId: id, running: true, statusDot: 'Running' });

(async () => {
  console.log('--- stale "Running" detection (pure) ---');
  {
    const now = Date.now();
    const out = sessions.decorate([
      { id: 'fresh', lastActivityAt: now - 30 * 1000 },
      { id: 'quiet9', lastActivityAt: now - 9 * MIN },
      { id: 'quiet11', lastActivityAt: now - 11 * MIN },
      { id: 'quiet82', lastActivityAt: now - 82 * MIN },
    ], snapOf(['fresh', 'quiet9', 'quiet11', 'quiet82'].map(run)));
    const by = Object.fromEntries(out.map(s => [s.id, s]));
    chk(by.fresh.running === true && by.fresh.stalled === false, 'a session writing 30s ago is running and NOT stalled');
    chk(by.quiet9.stalled === false, 'nine minutes of silence is still trusted (a long tool call may be quiet)', by.quiet9.stalled);
    chk(by.quiet11.stalled === true, 'eleven minutes of silence marks the status suspect', by.quiet11.stalled);
    chk(by.quiet82.stalled === true && Math.round(by.quiet82.quietFor / MIN) === 82, 'an 82-minute silence is caught, and the duration is reported', Math.round(by.quiet82.quietFor / MIN));
    chk(by.quiet82.running === true, 'stalled does NOT overwrite running -- the desktop\'s own claim is preserved');
  }

  console.log('\n--- stalled is only ever about RUNNING sessions ---');
  {
    const now = Date.now();
    const out = sessions.decorate([{ id: 'idle-old', lastActivityAt: now - 5 * 60 * MIN }], snapOf([{ sessionId: 'idle-old', running: false, statusDot: 'Idle' }]));
    chk(out[0].stalled === false && out[0].quietFor === 0, 'an idle session quiet for five hours is not "stalled"', { stalled: out[0].stalled, quietFor: out[0].quietFor });
    const noTs = sessions.decorate([{ id: 'no-ts', lastActivityAt: 0 }], snapOf([run('no-ts')]));
    chk(noTs[0].stalled === false, 'a session with no activity timestamp is never guessed at', noTs[0].stalled);
    const ghost = sessions.decorate([{ id: 'ghost', lastActivityAt: Date.now() - 99 * MIN }], snapOf([]));
    chk(ghost[0].stalled === false && ghost[0].running === false, 'a session absent from the desktop snapshot claims nothing at all');
  }

  console.log('\n--- the flag must actually REACH the phone ---');
  {
    const src = H.src('mobile/index.js');
    const i = src.indexOf('function slimSession');
    const slim = src.slice(i, i + 900);
    chk(i > 0 && /stalled:/.test(slim), 'slimSession forwards `stalled` to the client');
    chk(/quietFor:/.test(slim), 'slimSession forwards `quietFor` to the client');
    chk(/s\.stalled/.test(H.src('mobile/public/app.js')), 'and the app draws it');
  }

  console.log('\n--- cancel: shape and refusals ---');
  chk(typeof desktop.cancelSession === 'function', 'cancelSession is exported');
  {
    const r = await desktop.cancelSession('');
    chk(r && r.ok === false && r.error === 'NO_SESSION_ID', 'an empty session id is refused before any desktop work', r);
  }
  const up = await desktop.cdpAvailable();
  chk(up === false, 'precondition: no desktop reachable in the test world (nothing can be pressed)');
  {
    let r;
    try { r = await desktop.cancelSession('local_does-not-exist-0000'); } catch (e) { r = { ok: false, threw: e.code || e.message }; }
    chk(r && r.ok === false, 'with no desktop, a cancel fails closed (refuses or throws) instead of claiming success', r);
  }
  console.log('SKIP live refusals (unknown id -> not-found, idle -> not-running without moving the view): need a real Claude Desktop');

  H.finish(W);
})().catch(e => { console.error('THREW', e); process.exit(1); });
