// records.js — session records: presence (additive copy), archive state (by observed
// chronology) and session state (model, effort, error badge, unread) between subscription scopes.
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./core');

const KIND = 'sessions';
const FIRST_RUN_MODES = ['baseline', 'archived-wins'];

// Persisted and shown per session. "Needs input" and "working" are live-process state and are
// never written to a record, so there is nothing to carry for them.
const STATE_FIELDS = ['model', 'effort', 'lastActivityAt', 'lastFocusedAt', 'completedTurns', 'error', 'errorAt', 'errorCategory'];
const isLimitError = e => typeof e === 'string' && /hit your \w+ limit|usage limit reached/i.test(e);
function pickFields(j) { const o = {}; for (const k of STATE_FIELDS) if (j[k] !== undefined) o[k] = j[k]; return o; }

// Time fields take the max. Value fields move only when the incoming copy's activity is newer
// than both the target's activity and the last time the target was looked at. A usage-limit
// error from another account is cleared, not copied: the account it lands in has its own limit.
function mergedState(src, dst, frozen) {
  const want = { ...dst };
  for (const k of ['lastActivityAt', 'lastFocusedAt', 'completedTurns']) {
    const v = Math.max(src[k] || 0, dst[k] || 0); if (v) want[k] = v;
  }
  if (!frozen && (src.lastActivityAt || 0) > Math.max(dst.lastActivityAt || 0, dst.lastFocusedAt || 0)) {
    for (const k of ['model', 'effort', 'error', 'errorAt', 'errorCategory']) {
      if (src[k] === undefined) delete want[k]; else want[k] = src[k];
    }
    if (isLimitError(src.error)) { delete want.error; delete want.errorAt; delete want.errorCategory; }
  }
  return want;
}
const sameState = (a, b) => STATE_FIELDS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));

const recordFiles = scope => { try { return fs.readdirSync(scope.dir).filter(f => /^local_[0-9a-z-]+\.json$/i.test(f)); } catch { return []; } };
const idOf = f => f.replace(/\.json$/i, '');
const readRecord = (scope, file) => { try { return JSON.parse(fs.readFileSync(path.join(scope.dir, file), 'utf8')); } catch { return null; } };

// An unreadable record is PRESENT, never absent: counting it as missing would tombstone it and
// later delete it from the other scope.
function scan(scope) {
  const out = {}, st = core.cacheFor(scope.key);
  let unreadable = 0;
  for (const f of recordFiles(scope)) {
    const id = idOf(f);
    let stat = null; try { stat = fs.statSync(path.join(scope.dir, f)); } catch {}
    const c = st[id];
    if (stat && c && c.mt === stat.mtimeMs && c.sz === stat.size) {
      if (c.bad) { unreadable++; out[id] = { unreadable: true, file: f }; }
      else out[id] = { file: f, isArchived: c.a, title: c.t || '', fx: c.fx || {} };
      continue;
    }
    const j = readRecord(scope, f);
    if (!j || typeof j !== 'object') {
      unreadable++; out[id] = { unreadable: true, file: f };
      if (stat) st[id] = { mt: stat.mtimeMs, sz: stat.size, bad: true };
      continue;
    }
    out[id] = { file: f, isArchived: !!j.isArchived, title: j.title || '', fx: pickFields(j) };
    if (stat) st[id] = { mt: stat.mtimeMs, sz: stat.size, a: !!j.isArchived, t: String(j.title || '').slice(0, 80), fx: pickFields(j) };
  }
  for (const id of Object.keys(st)) if (out[id] === undefined) delete st[id];
  return { records: out, unreadable };
}

const comparable = r => r.unreadable ? { unreadable: true } : { a: r.isArchived ? 1 : 0 };

function plan(state, scopes, ctx) {
  const mode = FIRST_RUN_MODES.includes(ctx.firstRunMode) ? ctx.firstRunMode : 'baseline';
  const lines = [], actions = [], scans = {};
  for (const s of scopes) {
    scans[s.key] = scan(s);
    if (scans[s.key].unreadable) lines.push(ctx.label(s) + ': ' + scans[s.key].unreadable + ' unreadable record(s), counted as present');
  }
  const syncedIds = new Set(Object.keys(state.syncedRecordIds || {}));
  const firstFor = {};
  for (const s of scopes) {
    firstFor[s.key] = Object.keys(core.bucket(state, s.key, KIND)).length === 0;
    const vals = {};
    for (const [id, r] of Object.entries(scans[s.key].records)) vals[id] = comparable(r);
    const ch = core.observe(state, s.key, KIND, vals, { now: ctx.now,
      syncedIds, noTombstones: ctx.live.has(s.key), noTombstonesReason: 'Desktop is rewriting this scope from memory',
    });
    if (ch.tombstonesRefused) lines.push(ctx.label(s) + ': ' + ch.tombstonesRefused.ids.length + ' record(s) vanished, not treated as deletions (' + ch.tombstonesRefused.reason + ')');
    if (ch.tombstoned.length) lines.push(ctx.label(s) + ': ' + ch.tombstoned.length + ' record(s) deleted since the last sync (tombstoned)');
  }

  const stats = { agree: 0, undecided: 0, wouldDelete: 0, state: 0, limitCleared: 0 };
  const holdState = core.held(), frozen = core.frozenIds();
  const push = a => actions.push({ ...a, kind: 'records', pending: !ctx.writable.has(a.to) });

  for (const [A, B] of ctx.pairs) {
    const RA = scans[A.key].records, RB = scans[B.key].records;
    for (const id of Array.from(new Set([...Object.keys(RA), ...Object.keys(RB)])).sort()) {
      const ra = RA[id], rb = RB[id];
      if (ra && rb) {
        if (ra.unreadable || rb.unreadable) continue;
        if (A.mode === '1p' && B.mode === '1p' && !holdState) {
          for (const [src, dst, to, rec] of [[ra.fx, rb.fx, B, rb], [rb.fx, ra.fx, A, ra]]) {
            const want = mergedState(src, dst, !!frozen[id]);
            if (sameState(want, dst)) continue;
            stats.state++;
            if (!frozen[id] && isLimitError(src.error) && (src.lastActivityAt || 0) > Math.max(dst.lastActivityAt || 0, dst.lastFocusedAt || 0)) stats.limitCleared++;
            push({ op: 'setFields', id, to: to.key, file: rec.file, value: want });
          }
        }
        if (ra.isArchived === rb.isArchived) { stats.agree++; continue; }
        const ca = core.changedAtOf(state, A.key, KIND, id), cb = core.changedAtOf(state, B.key, KIND, id);
        const first = firstFor[A.key] || firstFor[B.key] || ca === cb;
        let winner = null;
        if (!first && ca && cb) winner = Date.parse(ca) > Date.parse(cb) ? 'a' : 'b';
        else if (mode === 'archived-wins') winner = ra.isArchived ? 'a' : 'b';
        else { stats.undecided++; continue; }
        const to = winner === 'a' ? B : A, want = winner === 'a' ? ra.isArchived : rb.isArchived;
        push({ op: 'setArchived', id, to: to.key, file: (winner === 'a' ? rb : ra).file, value: want, changedAt: winner === 'a' ? ca : cb });
        continue;
      }
      const have = ra ? A : B, lack = ra ? B : A, rec = ra || rb;
      const tomb = core.deletedHere(state, lack.key, KIND, id, core.changedAtOf(state, have.key, KIND, id));
      if (tomb) {
        if (ctx.allowDelete) push({ op: 'deleteRecord', id, to: have.key, file: rec.file });
        else stats.wouldDelete++;
        continue;
      }
      if (rec.unreadable) continue;
      push({ op: 'copyRecord', id, to: lack.key, from: have.key, file: rec.file, archived: !!rec.isArchived, changedAt: core.changedAtOf(state, have.key, KIND, id) });
    }
  }
  const seen = new Set(), deduped = [];
  for (const a of actions) { const k = a.op + '|' + a.id + '|' + a.to; if (!seen.has(k)) { seen.add(k); deduped.push(a); } }
  lines.push('archive state: ' + stats.agree + ' shared record(s) agree' +
             (stats.undecided ? ', ' + stats.undecided + ' differ with no chronology yet (left alone until a change is observed)' : ''));
  lines.push('session state (subscription accounts only): ' + (holdState ? 'ON HOLD - nothing written' : stats.state + ' to write' +
             (stats.limitCleared ? ', ' + stats.limitCleared + ' limit error(s) cleared rather than copied' : '')));
  if (stats.wouldDelete) lines.push(stats.wouldDelete + ' record(s) were deleted in one scope; deletion propagation is off, so nothing is removed');
  return { lines, actions: deduped, stats };
}

// A record we write keeps the mtime it had, so our writes never make an inactive scope look like
// the one Desktop is using. Times go in as seconds, not Dates: a Date drops the sub-millisecond part
// that Linux and macOS keep, and the copy would then differ from its source.
function keepMtime(target, source, whenMs) {
  try { const st = fs.statSync(source); fs.utimesSync(target, st.atimeMs / 1000, (whenMs || st.mtimeMs) / 1000); } catch {}
}

// A value this sync writes is recorded as observed WITH THE DATE OF THE CHANGE IT CARRIES.
// Otherwise the next run would see it as a fresh change, dated "now", and our own echo would
// outrank a real change made in a third scope in the meantime.
function noteWritten(state, key, id, archived, changedAt) {
  const b = core.bucket(state, key, KIND), v = { a: archived ? 1 : 0 }, now = new Date().toISOString();
  const prior = b[id] || {};
  b[id] = { value: v, sig: JSON.stringify(v), changedAt: changedAt || now, firstSeenAt: prior.firstSeenAt || now, present: true };
}

function apply(state, scopes, actions, journal) {
  const lines = [];
  const scopeOf = k => scopes.find(s => s.key === k);
  const n = { copyRecord: 0, setArchived: 0, setFields: 0, deleteRecord: 0 };
  const frozen = core.frozenIds();
  const touched = new Set();
  state.syncedRecordIds = state.syncedRecordIds || {};
  for (const a of actions) {
    const to = scopeOf(a.to), target = path.join(to.dir, a.file);
    if (a.op === 'copyRecord') {
      if (fs.existsSync(target)) continue;
      const src = path.join(scopeOf(a.from).dir, a.file);
      fs.copyFileSync(src, target);
      keepMtime(target, src);
      journal.push({ kind: 'records', op: 'copyRecord', scope: a.to, file: a.file });
      state.syncedRecordIds[a.id] = new Date().toISOString();
      noteWritten(state, a.to, a.id, a.archived, a.changedAt);
    } else if (a.op === 'setArchived' || a.op === 'setFields') {
      const j = readRecord(to, a.file);
      if (!j) { lines.push('skipped ' + a.id + ': became unreadable'); continue; }
      let was, want;
      if (a.op === 'setArchived') {
        if (!!j.isArchived === !!a.value) continue;
        was = !!j.isArchived;
      } else {
        const cur = pickFields(j);
        want = mergedState(a.value, cur, !!frozen[a.id]);
        if (sameState(want, cur)) continue;
        was = cur;
      }
      const mt = fs.statSync(target).mtimeMs;
      core.backup(target, 'record');
      journal.push({ kind: 'records', op: a.op, scope: a.to, file: a.file, was, mtimeMs: mt });
      if (a.op === 'setArchived') j.isArchived = !!a.value;
      else for (const k of STATE_FIELDS) { if (want[k] === undefined) delete j[k]; else j[k] = want[k]; }
      core.writeJsonAtomic(target, j);
      keepMtime(target, target, mt);
      if (a.op === 'setArchived') { state.syncedRecordIds[a.id] = new Date().toISOString(); noteWritten(state, a.to, a.id, !!a.value, a.changedAt); }
    } else if (a.op === 'deleteRecord') {
      const b = core.backup(target, 'record-deleted');
      fs.rmSync(target, { force: true });
      journal.push({ kind: 'records', op: 'deleteRecord', scope: a.to, file: a.file, backup: b });
    } else continue;
    core.invalidate(a.to, a.id);
    touched.add(a.to);
    n[a.op]++;
  }
  if (n.copyRecord) lines.push('copied ' + n.copyRecord + ' session record(s)');
  if (n.setArchived) lines.push('changed archive state on ' + n.setArchived + ' record(s)');
  if (n.setFields) lines.push('synced model/effort/unread state on ' + n.setFields + ' record(s)');
  if (n.deleteRecord) lines.push('removed ' + n.deleteRecord + ' record(s) against tombstones');
  for (const s of scopes) if (touched.has(s.key)) rebuildArchiveIndex(s, lines, journal);
  return { lines, counts: n };
}

// archived-sessions.idx is Desktop's cached list of archived ids; keep it consistent with the records.
function rebuildArchiveIndex(scope, lines, journal) {
  const f = path.join(scope.dir, 'archived-sessions.idx');
  if (!fs.existsSync(f)) return;
  const cur = core.readJson(f, null);
  if (!cur) return;
  const s = scan(scope);
  const archived = Object.keys(s.records).filter(id => s.records[id].isArchived && !s.records[id].unreadable).sort();
  const before = Array.isArray(cur.archived) ? cur.archived.slice().sort() : [];
  if (JSON.stringify(before) === JSON.stringify(archived)) return;
  const b = core.backup(f, 'idx');
  if (journal) journal.push({ kind: 'records', op: 'index', scope: scope.key, file: 'archived-sessions.idx', backup: b });
  core.writeJsonAtomic(f, { ...cur, v: cur.v || 1, archived }, 0);
  if (lines) lines.push('rebuilt the archive index for ' + scope.key.slice(0, 8) + ': ' + before.length + ' -> ' + archived.length);
}

function summary(scope) {
  const r = scan(scope).records;
  const ids = Object.keys(r);
  return { records: ids.length, archived: ids.filter(i => r[i].isArchived).length };
}

module.exports = { KIND, STATE_FIELDS, FIRST_RUN_MODES, mergedState, isLimitError, scan, plan, apply, rebuildArchiveIndex, summary };
