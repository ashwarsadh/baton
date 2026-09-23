// accounts-threeway.js — two subscription accounts plus the Gateway-mode (3p) scope, through the
// real run() path in the DEFAULT mode ('add', which carries archive state and session details
// but never removes anything). Proves:
//   1. an empty Gateway scope is filled with every record and routine, state preserved;
//   2. a second run is a no-op;
//   3. a change made in Gateway mode flows back to both subscription accounts;
//   4. two Desktops up at once (1p + 3p both written in the last 10 min): both are treated as live;
//   5. session state (model/effort/error/unread) crosses the subscription accounts only - the
//      Gateway copy never receives it - and older activity never overwrites a copy viewed later;
//   6. archive conflicts: the newest observed change wins; an undecidable one is left alone.
'use strict';
const fx = require('./accounts-fixture');
const fs = require('fs');
const path = require('path');
const { check } = fx;

(async () => {
  fx.installProbe();
  const sync = require('../lib/account-sync');
  const A = fx.scopeDir('aaaaaaaa-0000-4000-8000-000000000001', '0a0a0a0a-0000-4000-8000-000000000001');
  const B = fx.scopeDir('bbbbbbbb-0000-4000-8000-000000000002', '0b0b0b0b-0000-4000-8000-000000000002');
  const G = fx.scopeDir('dddddddd-0000-4000-8000-00000000dead', '00000000-0000-4000-8000-000000000000', fx.GW_SESS);
  const NOW = Date.now(), H = 3600000, D = 86400000;
  const id = n => 'local_' + String(n).repeat(8) + '-' + String(n).repeat(4) + '-4' + String(n).repeat(3) + '-8' + String(n).repeat(3) + '-' + String(n).repeat(12);
  const rec = (dir, n, archived, when, extra = {}) => fx.writeRec(dir, id(n), { sessionId: id(n), isArchived: archived, createdAt: 1, lastActivityAt: 1, title: 't' + n, ...extra }, when);
  const runAbsent = (extra = {}) => { fx.desk('absent'); return sync.run({ apply: true, presence: 'absent', ...extra }); };
  const all = r => r.lines.concat((r.applied && r.applied.lines) || []).join('\n');

  for (const d of [A, B]) {
    rec(d, 1, false, NOW - 2 * D); rec(d, 2, true, NOW - 2 * D); rec(d, 3, false, d === A ? NOW - H : NOW - 2 * D);
    fx.writeTasks(d, [fx.mkTask('r-on', true), fx.mkTask('r-off', false)]);
  }

  console.log('-- 1. an empty Gateway scope is filled (Desktop absent)');
  let out = await runAbsent();
  check(out.mode === 'add' && out.options.syncArchive && out.options.syncState, 'the default mode is add, with archive state and session details on');
  check(fx.recIds(G).length === 3, '3 records copied into the Gateway scope', all(out));
  check(fx.readRec(G, id(2)).isArchived === true, 'the archived one stays archived');
  check(fx.tasksOf(G).length === 2, '2 routines copied into the Gateway scope (a missing 3p registry counts as empty)');
  check(fx.tasksOf(G).find(t => t.id === 'r-off').enabled === false, 'the disabled routine stays disabled');
  check([A, B].every(d => fx.recIds(d).length === 3), 'the subscription scopes are untouched');

  console.log('-- 2. a second run is a no-op');
  out = await runAbsent();
  check(out.changeCount === 0 && out.pendingCount === 0, 'no changes', JSON.stringify(out.totals.now));

  console.log('-- 3. a change made in Gateway mode flows back');
  const r1 = fx.readRec(G, id(1)); r1.isArchived = true; fs.writeFileSync(path.join(G, id(1) + '.json'), JSON.stringify(r1));
  rec(G, 4, false, NOW - 2 * H);
  const mt = (d, n) => Math.round(fs.statSync(path.join(d, id(n) + '.json')).mtimeMs);
  const mtA1 = mt(A, 1);
  out = await runAbsent(); out = await runAbsent();
  check([A, B].every(d => fs.existsSync(path.join(d, id(4) + '.json'))), 'the new Gateway session appears in both accounts');
  check(mt(A, 4) === mt(G, 4) && mt(B, 4) === mt(G, 4) && mt(A, 1) === mtA1,
        'mtime kept: a copied record carries the source mtime and an archive flip keeps the record own mtime, so the sync never makes an account look like the one in use');
  check(fx.readRec(A, id(1)).isArchived === true, 'an archive made in Gateway mode reaches A (default mode)', all(out));
  check(fx.readRec(B, id(1)).isArchived === true, 'and reaches B');

  console.log('-- 4. two Desktops up at once');
  rec(A, 3, false, NOW); rec(G, 3, false, NOW - 60000);
  rec(B, 5, false, NOW - D);
  fx.desk('live');
  out = await sync.run({ apply: true, presence: 'live' });
  check(/2 accounts were written in the last 10 minutes/.test(all(out)), 'warns that 2 scopes are live', all(out));
  check(!fs.existsSync(path.join(A, id(5) + '.json')), 'A (live) did not receive the B-only record');
  check(!fs.existsSync(path.join(G, id(5) + '.json')), 'the Gateway scope (live) did not receive it either');
  check(out.totals.pending.records >= 2, 'it is reported as pending, not dropped', JSON.stringify(out.totals.pending));

  console.log('-- 5. session state crosses the subscription accounts only');
  const S = 6, LIMIT = "You've hit your weekly limit - resets soon";
  const put = (dir, obj) => fx.writeRec(dir, id(S), { sessionId: id(S), isArchived: false, createdAt: 1, title: 'state', ...obj }, NOW - 2 * H);
  put(A, { model: 'model-new', effort: 'high', lastActivityAt: 2000, lastFocusedAt: 1500, completedTurns: 9, error: LIMIT, errorAt: 2000 });
  put(B, { model: 'model-old', effort: 'medium', lastActivityAt: 1000, lastFocusedAt: 1900, completedTurns: 4 });
  put(G, { model: 'gw-model', effort: 'low', lastActivityAt: 500, lastFocusedAt: 500 });
  out = await runAbsent();
  const rs = d => fx.readRec(d, id(S));
  let a5 = rs(A), b5 = rs(B), g5 = rs(G);
  check(b5.model === 'model-new' && b5.effort === 'high', 'B gets A\'s newer model and effort', JSON.stringify(b5));
  check(b5.error === undefined && b5.errorAt === undefined, 'A\'s usage-limit error is cleared in B, not copied');
  check(a5.error === LIMIT, 'A keeps its own limit error');
  check(a5.lastActivityAt === 2000 && b5.lastActivityAt === 2000 && a5.lastFocusedAt === 1900 && b5.lastFocusedAt === 1900 && b5.completedTurns === 9, 'unread fields take the max on both sides');
  check(g5.model === 'gw-model' && g5.effort === 'low' && g5.lastActivityAt === 500, 'the Gateway (3p) copy never receives state fields');
  check(/1 limit error\(s\) cleared/.test(all(out)), 'reported as a limit error cleared', all(out));
  out = await runAbsent();
  check(/session state \(subscription accounts only\): 0 to write/.test(all(out)), 'state sync is idempotent');
  put(B, { ...rs(B), model: 'model-b-newest', lastActivityAt: 3000 });
  await runAbsent();
  a5 = rs(A);
  check(a5.model === 'model-b-newest' && a5.error === undefined && a5.lastActivityAt === 3000, 'newer B state flows back to A and clears A\'s stale error', JSON.stringify(a5));
  check(rs(G).model === 'gw-model', 'the Gateway copy is still untouched');
  put(A, { ...rs(A), model: 'older-work-model', effort: 'low', lastActivityAt: 4000 });
  put(B, { ...rs(B), model: 'picked-while-viewing', effort: 'max', lastFocusedAt: 4500 });
  await runAbsent();
  check(rs(B).model === 'picked-while-viewing' && rs(B).effort === 'max', 'older activity never overwrites a copy viewed later (lastFocusedAt)', JSON.stringify(rs(B)));
  check(rs(A).model === 'older-work-model', 'A keeps its own value (its activity is newer than B\'s copy)');
  await runAbsent({ mode: 'two-way' });
  check(rs(G).model === 'gw-model' && rs(G).effort === 'low', 'even two-way never writes state fields into the Gateway scope');
  put(A, { ...rs(A), model: 'off-switch', lastActivityAt: 9000 });
  await runAbsent({ syncState: false });
  check(rs(B).model === 'picked-while-viewing', 'with session details switched off, no state is written');

  console.log('-- 6. archive conflicts');
  rec(A, 7, true, NOW - 3 * D); rec(B, 7, false, NOW - 3 * D); rec(G, 7, false, NOW - 3 * D);
  out = await runAbsent();
  check(fx.readRec(A, id(7)).isArchived === true && fx.readRec(B, id(7)).isArchived === false && /differ with no chronology yet/.test(all(out)),
        'first seen differing: undecidable, left alone', all(out));
  const flip = (d, v) => { const r = fx.readRec(d, id(7)); r.isArchived = v; fs.writeFileSync(path.join(d, id(7) + '.json'), JSON.stringify(r)); };
  flip(A, false); flip(B, true);
  await runAbsent();
  check(fx.readRec(A, id(7)).isArchived === false && fx.readRec(B, id(7)).isArchived === true, 'both flipped between the same two runs: equal observation times, left alone');
  await new Promise(r => setTimeout(r, 15));
  flip(B, false);
  await runAbsent();
  check([A, B, G].every(d => fx.readRec(d, id(7)).isArchived === false), 'one side changes later: the newest observed change wins everywhere');
  await new Promise(r => setTimeout(r, 15));
  flip(G, true);
  await runAbsent();
  check([A, B].every(d => fx.readRec(d, id(7)).isArchived === true), 'and in the other direction (archived in Gateway mode, newest)');
  rec(A, 8, true, NOW - 3 * D); rec(B, 8, false, NOW - 3 * D); rec(G, 8, false, NOW - 3 * D);
  // A clock that moves 5 ms on every read: without one timestamp per pass, the scopes observed
  // later would look "changed later" and unarchive it (this was a real intermittent failure).
  const RealDate = Date; let tick = 0;
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + (tick += 5)); } static now() { return RealDate.now() + tick; } };
  try { await runAbsent({ firstRunMode: 'archived-wins' }); } finally { global.Date = RealDate; }
  check([A, B, G].every(d => fx.readRec(d, id(8)).isArchived === true), 'first-run mode archived-wins settles a first-seen difference as archived');

  fx.done('three-way');
})().catch(fx.fail);
