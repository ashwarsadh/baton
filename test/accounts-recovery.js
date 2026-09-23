// accounts-recovery.js — rehearses the one scenario that decides whether the sync is safe:
// Desktop rewrites the ACTIVE scope's routine registry from a stale copy in memory (9 routines on
// disk become 1) while nobody touched anything.
//   1. That must NOT be read as eight deletions (which the next pass would carry to the other
//      account, losing the routines everywhere).
//   2. The work must come back by itself: pending while Desktop runs, restored at the next exit,
//      each routine enabled or disabled exactly as it was.
//   3. A real, single deletion still works once it can be judged, and a mass wipe never does.
// Run through the real run() path on a sandbox of fake scopes with a stubbed presence probe.
'use strict';
const fx = require('./accounts-fixture');
const fs = require('fs');
const path = require('path');
const { check } = fx;

(async () => {
  fx.installProbe();
  const sync = require('../lib/account-sync');
  const ACTIVE = fx.scopeDir('aaaaaaaa-0000-4000-8000-000000000001', '0a0a0a0a-0000-4000-8000-000000000001');
  const OTHER = fx.scopeDir('bbbbbbbb-0000-4000-8000-000000000002', '0b0b0b0b-0000-4000-8000-000000000002');
  const now = Date.now();
  const rec = id => ({ sessionId: id, isArchived: false, createdAt: 1, lastActivityAt: 1, title: 't' });
  fx.writeRec(ACTIVE, fx.sid(1), rec(fx.sid(1)), now - 1000);           // newest record: Desktop's scope
  fx.writeRec(OTHER, fx.sid(1), rec(fx.sid(1)), now - 86400000);
  const NINE = [['check-a', true], ['resume-b', false], ['resume-c', false], ['engine-d', true], ['sweep-e', true],
                ['pairing-f', false], ['weekly-g', true], ['probe-h', true], ['label-i', true]].map(([id, on]) => fx.mkTask(id, on));
  fx.writeTasks(ACTIVE, NINE); fx.writeTasks(OTHER, NINE.map(t => ({ ...t })));
  const run = (desk, extra = {}) => { fx.desk(desk); return sync.run({ apply: true, presence: desk, ...extra }); };
  const lines = r => r.lines.concat((r.applied && r.applied.lines) || []).join('\n');

  // Two clean cycles first, so the store holds real observations.
  await run('live'); await run('live');

  console.log('-- 1. Desktop persists its stale registry: 9 routines -> 1');
  fx.writeTasks(ACTIVE, [fx.mkTask('check-a', true)]);
  check(fx.tasksOf(ACTIVE).length === 1, 'setup: the active scope really is down to 1 routine');
  const live = await run('live');
  const activeKey = live.active;
  check(/8 routine\(s\) vanished, not treated as deletions/.test(lines(live)), 'the 8 vanished routines are NOT tombstoned', lines(live));
  check(/Desktop is rewriting this scope from memory/.test(lines(live)), 'the refusal names the live scope as the reason');
  check(fx.tasksOf(OTHER).length === 9, 'the other account still has all 9 - no deletion propagated');
  check(live.scopes.find(s => s.key === activeKey).pending.routines >= 1, 'the restore is reported as pending, not silently skipped');
  check(fx.tasksOf(ACTIVE).length === 1, 'nothing was written to the live scope while Desktop is up');

  console.log('-- 2. Desktop exits; the same code runs with Desktop absent');
  const exit = await run('absent');
  const back = fx.tasksOf(ACTIVE);
  check(back.length === 9, 'all 9 routines are restored to the active scope', back.map(t => t.id).join(','));
  const disabled = back.filter(t => !t.enabled).map(t => t.id).sort(), enabled = back.filter(t => t.enabled);
  check(disabled.length === 3, 'exactly 3 come back disabled, as they were left');
  check(disabled.join(',') === 'pairing-f,resume-b,resume-c', 'the right 3 are disabled', disabled.join(','));
  check(enabled.length === 6, 'the other 6 come back enabled');
  check(!!(exit.applied && exit.applied.journal), 'the restore wrote a journal, so it can be undone');

  console.log('-- 3. a real deletion still works, once it can be judged');
  fx.writeTasks(OTHER, fx.tasksOf(OTHER).filter(t => t.id !== 'probe-h'));
  const del1 = await run('absent');
  check(/routine\(s\) deleted since the last sync \(tombstoned\): probe-h/.test(lines(del1)), 'a single deletion IS tombstoned', lines(del1));
  check(fx.tasksOf(ACTIVE).some(t => t.id === 'probe-h') && /deletion propagation is off/.test(lines(del1)), 'but nothing is removed while deletion is off');
  await run('absent', { mode: 'two-way', allowDelete: true });
  check(!fx.tasksOf(ACTIVE).some(t => t.id === 'probe-h'), 'with deletion allowed (two-way) the deletion propagates');
  check(fx.tasksOf(ACTIVE).length === 8, 'and only that one routine went', String(fx.tasksOf(ACTIVE).length));

  console.log('-- 4. an accidental mass wipe of the inactive scope is still refused');
  fx.writeTasks(OTHER, [fx.mkTask('check-a', true)]);
  const wipe = await run('absent', { mode: 'two-way', allowDelete: true });
  check(/7 routine\(s\) vanished, not treated as deletions/.test(lines(wipe)), 'a wholesale wipe is NOT read as deletions', lines(wipe));
  check(fx.tasksOf(ACTIVE).length === 8, 'the surviving side keeps its routines');
  check(fx.tasksOf(OTHER).length === 8, 'and the wiped side is refilled additively');

  console.log('-- 5. a missing registry in a subscription account refuses the routines pass');
  fs.rmSync(path.join(OTHER, 'scheduled-tasks.json'));
  const miss = await run('absent');
  check(/routines: not touched - the registry in .* is unreadable \(the registry file is missing\)/.test(lines(miss)) && !fs.existsSync(path.join(OTHER, 'scheduled-tasks.json')) && fx.tasksOf(ACTIVE).length === 8,
        'missing 1p registry: routines refused, nothing written, the other side keeps all 8', lines(miss));

  fx.done('clobber-recovery');
})().catch(fx.fail);
