// routines.js — the per-scope routine registry (scheduled-tasks.json).
//
// The routine definitions (SKILL.md files) are shared by every account; only the registry that
// points at them is per scope, which is why switching account can silently stop routines.
// A copied routine keeps its own state: `enabled` verbatim (switching a disabled routine back on
// is a change nobody asked for) and lastRunAt / lastScheduledFor / missedRunScanFloor, so it
// does not decide it has a month of missed runs to catch up on.
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./core');

const KIND = 'routines';
const fileFor = scope => path.join(scope.dir, 'scheduled-tasks.json');

// An unreadable registry is not an empty one: refuse to reason about routines at all, or every
// routine in it would look deleted and, later, be deleted from the other accounts too.
// The one exception is a MISSING file in a Gateway-mode (3p) scope: the app creates the file
// lazily, so a freshly set-up Gateway scope genuinely has no routines yet. A missing file in a
// subscription (1p) scope is not that case (Desktop writes it as soon as the account is used),
// so it refuses like an unreadable one.
function readRegistry(scope) {
  try {
    const j = JSON.parse(fs.readFileSync(fileFor(scope), 'utf8'));
    return { ok: true, tasks: Array.isArray(j.scheduledTasks) ? j.scheduledTasks : [], raw: j };
  } catch (e) {
    if (e.code === 'ENOENT' && scope.mode === '3p') return { ok: true, tasks: [], raw: { scheduledTasks: [], recordedSkips: [] }, created: true };
    return { ok: false, tasks: [], raw: null, error: e.code === 'ENOENT' ? 'the registry file is missing' : e.message };
  }
}

// filePath is computed by the app per scope at load, so it is derived, not authored.
function comparable(t) {
  const { filePath, ...rest } = t;
  const out = {};
  for (const k of Object.keys(rest).sort()) out[k] = rest[k];
  return out;
}
const dateOf = t => Math.max(Date.parse(t.lastRunAt || '') || 0, Date.parse(t.lastScheduledFor || '') || 0, t.createdAt || 0);
const byId = tasks => { const m = {}; for (const t of tasks) if (t && typeof t.id === 'string') m[t.id] = t; return m; };

function pickWinner(state, aKey, bKey, id, ta, tb) {
  if (JSON.stringify(comparable(ta)) === JSON.stringify(comparable(tb))) return 'tie';
  const ca = core.changedAtOf(state, aKey, KIND, id), cb = core.changedAtOf(state, bKey, KIND, id);
  if (ca && cb && ca !== cb) return Date.parse(ca) > Date.parse(cb) ? 'a' : 'b';
  const da = dateOf(ta), db = dateOf(tb);
  if (da !== db) return da > db ? 'a' : 'b';
  return 'conflict';
}

function plan(state, scopes, ctx) {
  const lines = [], actions = [], regs = {};
  for (const s of scopes) {
    regs[s.key] = readRegistry(s);
    if (!regs[s.key].ok) {
      lines.push('routines: not touched - the registry in ' + ctx.label(s) + ' is unreadable (' + regs[s.key].error + ')');
      return { lines, actions: [], blocked: true };
    }
  }
  const syncedIds = new Set(Object.keys(state.syncedRoutineIds || {}));
  for (const s of scopes) {
    const vals = {};
    for (const [id, t] of Object.entries(byId(regs[s.key].tasks))) vals[id] = comparable(t);
    const ch = core.observe(state, s.key, KIND, vals, { now: ctx.now,
      syncedIds, noTombstones: ctx.live.has(s.key), noTombstonesReason: 'Desktop is rewriting this scope from memory',
    });
    if (ch.tombstonesRefused) lines.push(ctx.label(s) + ': ' + ch.tombstonesRefused.ids.length + ' routine(s) vanished, not treated as deletions (' + ch.tombstonesRefused.reason + ')');
    if (ch.tombstoned.length) lines.push(ctx.label(s) + ': ' + ch.tombstoned.length + ' routine(s) deleted since the last sync (tombstoned): ' + ch.tombstoned.join(', '));
  }
  let conflicts = 0, wouldDelete = 0;
  const push = a => actions.push({ ...a, kind: 'routines', pending: !ctx.writable.has(a.to) });
  for (const [A, B] of ctx.pairs) {
    const ra = byId(regs[A.key].tasks), rb = byId(regs[B.key].tasks);
    for (const id of Array.from(new Set([...Object.keys(ra), ...Object.keys(rb)])).sort()) {
      const ta = ra[id], tb = rb[id];
      if (ta && tb) {
        const w = pickWinner(state, A.key, B.key, id, ta, tb);
        if (w === 'tie') continue;
        if (w === 'conflict') { conflicts++; continue; }
        const to = w === 'a' ? B : A, src = w === 'a' ? ta : tb, dst = w === 'a' ? tb : ta;
        push({ op: 'routineUpdate', id, to: to.key, task: dst.filePath ? { ...src, filePath: dst.filePath } : { ...src }, changedAt: core.changedAtOf(state, w === 'a' ? A.key : B.key, KIND, id) });
        continue;
      }
      const have = ta ? A : B, lack = ta ? B : A, task = ta || tb;
      if (core.deletedHere(state, lack.key, KIND, id, core.changedAtOf(state, have.key, KIND, id))) {
        if (ctx.allowDelete) push({ op: 'routineDelete', id, to: have.key });
        else wouldDelete++;
        continue;
      }
      push({ op: 'routineCopy', id, to: lack.key, task: { ...task }, enabled: !!task.enabled, changedAt: core.changedAtOf(state, have.key, KIND, id) });
    }
  }
  if (conflicts) lines.push('routines: ' + conflicts + ' differ with no way to tell which is newer - left alone');
  if (wouldDelete) lines.push('routines: ' + wouldDelete + ' deleted in one scope; deletion propagation is off');
  const seen = new Set(), deduped = [];
  for (const a of actions) { const k = a.op + '|' + a.id + '|' + a.to; if (!seen.has(k)) { seen.add(k); deduped.push(a); } }
  return { lines, actions: deduped, blocked: false };
}

function apply(state, scopes, actions, journal) {
  const lines = [], byScope = {};
  for (const a of actions) (byScope[a.to] = byScope[a.to] || []).push(a);
  state.syncedRoutineIds = state.syncedRoutineIds || {};
  for (const key of Object.keys(byScope)) {
    const scope = scopes.find(s => s.key === key), f = fileFor(scope);
    const r = readRegistry(scope);
    if (!r.ok) { lines.push('routines: skipped ' + key.slice(0, 8) + ', registry unreadable'); continue; }
    const b = core.backup(f, 'routines');
    journal.push({ kind: 'routines', op: 'registry', scope: key, file: 'scheduled-tasks.json', backup: b, created: !b });
    const map = byId(r.tasks), order = r.tasks.map(t => t.id);
    for (const a of byScope[key]) {
      if (a.op === 'routineDelete') { delete map[a.id]; const i = order.indexOf(a.id); if (i >= 0) order.splice(i, 1); }
      else {
        if (!map[a.id]) order.push(a.id); map[a.id] = a.task;
        // Record what we wrote with the date of the change it carries, so it is not re-dated as new.
        const obs = core.bucket(state, key, KIND), v = comparable(a.task), prior = obs[a.id] || {}, now = new Date().toISOString();
        obs[a.id] = { value: v, sig: JSON.stringify(v), changedAt: a.changedAt || now, firstSeenAt: prior.firstSeenAt || now, present: true };
      }
      state.syncedRoutineIds[a.id] = new Date().toISOString();
    }
    const out = { ...(r.raw || {}), scheduledTasks: order.filter(id => map[id]).map(id => map[id]) };
    core.writeJsonAtomic(f, out);
    lines.push('routines: wrote ' + out.scheduledTasks.length + ' to ' + key.slice(0, 8) + ' (' + out.scheduledTasks.filter(t => t.enabled).length + ' enabled)');
  }
  return { lines };
}

function summary(scope) {
  const r = readRegistry(scope);
  return r.ok ? { routines: r.tasks.length, routinesEnabled: r.tasks.filter(t => t.enabled).length } : { routines: null, routinesEnabled: null };
}

module.exports = { KIND, plan, apply, readRegistry, comparable, summary };
