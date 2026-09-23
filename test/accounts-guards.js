// accounts-guards.js — the rules that decide whether the account sync is safe or catastrophic.
//
// 1. Tombstones are EARNED, not inferred: every way "a record is here and not there" can arise
//    without anybody deleting anything must NOT produce a tombstone.
// 2. The writable set and the presence classifier: never write where Desktop is the author.
// 3. The presence cache: a display may reuse an answer, the check that permits a write may not,
//    and a presence handed down by a caller can refuse a write but never permit one.
// All on temp copies with a stubbed presence probe.
'use strict';
const fx = require('./accounts-fixture');
const fs = require('fs');
const path = require('path');
const { check } = fx;

(async () => {
  const core = require('../lib/account-sync/core');
  const pres = require('../lib/account-sync/presence');
  const sync = require('../lib/account-sync');
  const fresh = () => ({ version: 1, firstRunAt: null, runs: 0, observed: {}, tombstones: {} });
  const S = 'acct/org';
  const spin = ms => { const t = Date.now() + ms; while (Date.now() < t); };

  console.log('-- tombstones are earned, not inferred');
  {
    const st = fresh();
    core.observe(st, S, 'routines', { a: { x: 1 } }, { syncedIds: new Set() });
    const ch = core.observe(st, S, 'routines', {}, { syncedIds: new Set() });
    check(ch.vanished.includes('a') && !ch.tombstoned.length && !core.tombBucket(st, S, 'routines').a, 'never-synced record vanishing -> no tombstone');
  }
  {
    const st = fresh(), synced = new Set(['a']);
    core.observe(st, S, 'routines', { a: { x: 1 }, b: { x: 1 }, c: { x: 1 }, d: { x: 1 }, e: { x: 1 } }, { syncedIds: synced });
    const ch = core.observe(st, S, 'routines', { b: { x: 1 }, c: { x: 1 }, d: { x: 1 }, e: { x: 1 } }, { syncedIds: synced });
    check(ch.tombstoned.includes('a'), 'previously-synced record vanishing alone -> tombstone');
  }

  console.log('-- the live scope rewrites itself from memory: never a deletion');
  {
    const st = fresh(), synced = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']);
    const nine = {}; for (let i = 1; i <= 8; i++) nine['r' + i] = { x: 1 }; nine.keep = { x: 1 };
    core.observe(st, S, 'routines', nine, { syncedIds: synced });
    const ch = core.observe(st, S, 'routines', { keep: { x: 1 } }, { syncedIds: synced, noTombstones: true, noTombstonesReason: 'live scope' });
    check(ch.vanished.length === 8 && ch.tombstoned.length === 0 && !!ch.tombstonesRefused, 'live-scope clobber -> no tombstones at all');
    check(ch.tombstonesRefused && ch.tombstonesRefused.ids.length === 8, 'live-scope clobber -> the refusal is reported, not silent');
    check(Object.keys(core.tombBucket(st, S, 'routines')).length === 0, 'live-scope clobber -> nothing landed in the tombstone store');
  }

  console.log('-- people delete one thing at a time');
  {
    const st = fresh(), many = {}; for (let i = 0; i < 20; i++) many['s' + i] = { a: 0 };
    const synced = new Set(Object.keys(many));
    core.observe(st, S, 'sessions', many, { syncedIds: synced });
    const left = {}; for (let i = 0; i < 5; i++) left['s' + i] = { a: 0 };
    const ch = core.observe(st, S, 'sessions', left, { syncedIds: synced });
    check(ch.tombstoned.length === 0 && !!ch.tombstonesRefused, '15 of 20 vanish at once -> no tombstones');
    check(ch.vanished.length === 15 && core.bucket(st, S, 'sessions').s19.present === false, 'mass vanish -> the disappearance is still recorded');
  }
  {
    const st = fresh(), many = {}; for (let i = 0; i < 20; i++) many['s' + i] = { a: 0 };
    const synced = new Set(Object.keys(many));
    core.observe(st, S, 'sessions', many, { syncedIds: synced });
    const left = { ...many }; delete left.s0; delete left.s1;
    const ch = core.observe(st, S, 'sessions', left, { syncedIds: synced });
    check(ch.tombstoned.length === 2 && !ch.tombstonesRefused, '2 of 20 vanish -> tombstoned normally (the guard is not a blanket veto)');
  }

  console.log('-- chronology behaves like a clock, not a run counter');
  {
    const st = fresh();
    core.observe(st, S, 'sessions', { a: { a: 0 } }, { syncedIds: new Set() });
    const t1 = core.changedAtOf(st, S, 'sessions', 'a'); spin(12);
    core.observe(st, S, 'sessions', { a: { a: 0 } }, { syncedIds: new Set() });
    check(core.changedAtOf(st, S, 'sessions', 'a') === t1, 'unchanged value keeps its original changedAt');
  }
  {
    const st = fresh();
    core.observe(st, S, 'sessions', { a: { a: 0 } }, { syncedIds: new Set() });
    const t1 = core.changedAtOf(st, S, 'sessions', 'a'); spin(12);
    const ch = core.observe(st, S, 'sessions', { a: { a: 1 } }, { syncedIds: new Set() });
    check(ch.changed.includes('a') && core.changedAtOf(st, S, 'sessions', 'a') !== t1, 'an archive flip re-dates the record');
  }

  console.log('-- a record coming back outranks its own disappearance');
  {
    const st = fresh(), synced = new Set(['a']);
    core.observe(st, S, 'routines', { a: { x: 1 }, b: {}, c: {}, d: {}, e: {} }, { syncedIds: synced });
    core.observe(st, S, 'routines', { b: {}, c: {}, d: {}, e: {} }, { syncedIds: synced });
    check(!!core.tombBucket(st, S, 'routines').a, 'tombstone exists after the disappearance');
    core.observe(st, S, 'routines', { a: { x: 1 }, b: {}, c: {}, d: {}, e: {} }, { syncedIds: synced });
    check(!core.tombBucket(st, S, 'routines').a, 'the record returns -> its tombstone is cancelled');
  }
  {
    const st = fresh(), synced = new Set(['a']);
    core.observe(st, 'A/1', 'routines', { a: { x: 1 }, b: {}, c: {}, d: {}, e: {} }, { syncedIds: synced });
    core.observe(st, 'A/1', 'routines', { b: {}, c: {}, d: {}, e: {} }, { syncedIds: synced });
    const tombAt = core.tombBucket(st, 'A/1', 'routines').a.goneAt;
    check(core.deletedHere(st, 'A/1', 'routines', 'a', new Date(Date.parse(tombAt) + 60000).toISOString()) === null, 'a deletion older than the other side\'s change does not apply');
    check(core.deletedHere(st, 'A/1', 'routines', 'a', new Date(Date.parse(tombAt) - 60000).toISOString()) !== null, 'a deletion newer than the other side\'s change applies');
  }

  console.log('-- writable set: never write where the app is the author');
  check(sync.writableFor('absent').set === 'all', 'absent -> everything writable');
  check(sync.writableFor('orphans-only').set === 'all', 'orphans-only -> everything writable');
  check(sync.writableFor('live').set === 'inactive', 'live -> inactive scopes only');
  check(sync.writableFor('launching').set === 'inactive', 'launching -> inactive scopes only');
  check(sync.writableFor('unknown').set === 'none', 'unknown -> nothing writable');

  console.log('-- presence classifier (every shape measured on a real machine)');
  const cases = [
    ['no Desktop process at all', [], 'absent'],
    ['main 1s old, no children yet (launching)', [{ pid: 1, age: 1, main: true, kids: false }], 'launching'],
    ['main 4s old, still no children', [{ pid: 1, age: 4, main: true, kids: false }], 'launching'],
    ['childless main, minutes old (orphan left by a quit)', [{ pid: 2, age: 900, main: true, kids: false }], 'orphans-only'],
    ['main with children', [{ pid: 3, age: 500, main: true, kids: true }, { pid: 4, age: 499, main: false, kids: false }], 'live'],
    ['orphan AND a launching main -> refuse', [{ pid: 2, age: 900, main: true, kids: false }, { pid: 5, age: 2, main: true, kids: false }], 'launching'],
    ['orphan AND a live main -> live', [{ pid: 2, age: 900, main: true, kids: false }, { pid: 3, age: 500, main: true, kids: true }], 'live'],
    ['stray child, no main (mid-teardown) -> refuse', [{ pid: 4, age: 5, main: false, kids: false }], 'launching'],
    ['unparseable probe output -> unknown', [{ pid: NaN, age: 0, main: true, kids: false }], 'unknown'],
    ['an unreadable Desktop process in our session -> unknown, never absent', [{ pid: 6, age: 300, opaque: true, main: false, kids: true }], 'unknown'],
    ['unreadable alongside a live main -> still unknown', [{ pid: 6, age: 300, opaque: true, main: false, kids: false }, { pid: 3, age: 500, main: true, kids: true }], 'unknown'],
  ];
  for (const [name, procs, want] of cases) { const got = pres.classify(procs); check(got === want, 'classify: ' + name + ' -> ' + want, 'got ' + got); }

  console.log('-- presence cache: display may reuse, a write may not');
  fx.installProbe();
  const n0 = fx.probes();
  await pres.presence(); const n1 = fx.probes();
  await pres.presence(); const n2 = fx.probes();
  await pres.presence({ fresh: true }); const n3 = fx.probes();
  check(n1 === n0 + 1, 'a cold call really probes');
  check(n2 === n1, 'a repeat call inside the TTL is served from the cache');
  check(n3 === n2 + 1, '{ fresh: true } always really probes - the write gate');
  check(pres.CACHE_TTL_MS === 2000, 'the cache lives 2 s');
  const r = pres.resolver('absent');
  fx.desk('live');
  check((await r({})).state === 'absent', 'a handed-down state answers the early (cheap) question');
  check((await r({ fresh: true })).state === 'live', 'a handed-down "absent" never permits: the fresh check really probes and says live');
  fx.desk('absent');
  check((await pres.resolver('live')({ fresh: true })).state === 'live', 'a handed-down "live" still refuses even when the probe says absent');

  console.log('-- a handed-down "absent" cannot open the active scope or the groups');
  const A = fx.scopeDir('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const B = fx.scopeDir('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const now = Date.now();
  fx.writeRec(A, fx.sid(1), { sessionId: fx.sid(1), isArchived: false, title: 'a' }, now - 1000);
  fx.writeRec(A, fx.sid(2), { sessionId: fx.sid(2), isArchived: false, title: 'b' }, now - 1000);
  fx.writeRec(B, fx.sid(3), { sessionId: fx.sid(3), isArchived: false, title: 'c' }, now - 86400000);
  fx.writeTasks(A, []); fx.writeTasks(B, []);
  const aHash = fx.hashTree(A);
  fx.desk('live');
  const hd = await sync.run({ apply: true, presence: 'absent' });
  check(fx.hashTree(A) === aHash, 'hint "absent", Desktop really live: the active scope was not written', (hd.applied || {}).lines && hd.applied.lines.join(' | '));
  check(fx.recIds(B).length === 3, 'the inactive scope was still written');
  check(hd.applied.lines.some(l => /checked just before writing/.test(l)), 'the refusal is reported');

  console.log('-- unknown presence: nothing is writable');
  fx.desk('unknown');
  const bHash = fx.hashTree(B), aHash2 = fx.hashTree(A);
  fx.writeRec(B, fx.sid(4), { sessionId: fx.sid(4), isArchived: false, title: 'd' }, now - 86400000);
  const bHash2 = fx.hashTree(B);
  const un = await sync.run({ apply: true });
  check(un.presence === 'unknown' && fx.hashTree(A) === aHash2 && fx.hashTree(B) === bHash2 && bHash !== bHash2, 'presence unknown: no scope was written', JSON.stringify(un.totals.now));
  check(un.scopes.every(s => !s.writable), 'presence unknown: every scope reported not writable');

  fx.done('guard');
})().catch(fx.fail);
