'use strict';
const fs = require('fs');
const path = require('path');

const registry = require('./registry');

function stateDir() { return require('./config').STATE; }
const FILE = () => path.join(stateDir(), 'awaits.json');

const DEFAULT_DEADLINE_MS = 2 * 60 * 60 * 1000;
const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;
const STALE_AFTER_MS = 45 * 60 * 1000;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return Array.isArray(j.watches) ? j : { version: 1, watches: [] };
  } catch { return { version: 1, watches: [] }; }
}
function save(state) {
  const f = FILE();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, f);
  } catch {}
  return state;
}

const now = () => Date.now();
const iso = ms => new Date(ms).toISOString();

function park({ masterSessionId, project, waitingOn, reason, deadlineMs }) {
  if (!masterSessionId) return { ok: false, error: 'NO_MASTER_SESSION' };
  const ids = (Array.isArray(waitingOn) ? waitingOn : [waitingOn]).filter(Boolean);
  if (!ids.length) return { ok: false, error: 'NOTHING_TO_WAIT_ON' };

  const dl = Math.min(Number(deadlineMs) > 0 ? Number(deadlineMs) : DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS);
  const st = load();
  st.watches = st.watches.filter(w => !(w.masterSessionId === masterSessionId && !w.resolvedAt));
  const watch = {
    id: 'w' + now().toString(36),
    masterSessionId, project: project || null,
    waitingOn: ids,
    reason: String(reason || '').slice(0, 400) || null,
    createdAt: iso(now()),
    deadlineAt: iso(now() + dl),
    nudgedAt: null,
    resolvedAt: null, resolution: null,
  };
  st.watches.unshift(watch);
  st.watches = st.watches.slice(0, 200);
  save(st);
  return { ok: true, watch };
}

function watchFor(masterSessionId) {
  return load().watches.find(w => w.masterSessionId === masterSessionId && !w.resolvedAt) || null;
}
function list({ includeResolved = false } = {}) {
  const ws = load().watches;
  return includeResolved ? ws : ws.filter(w => !w.resolvedAt);
}
function cancel(id) {
  const st = load();
  const w = st.watches.find(x => x.id === id || x.masterSessionId === id);
  if (!w || w.resolvedAt) return { ok: false, error: 'NO_SUCH_WATCH' };
  w.resolvedAt = iso(now());
  w.resolution = 'cancelled';
  save(st);
  return { ok: true, watch: w };
}

const TERMINAL_TASK = new Set(['done', 'failed', 'cancelled']);

function stateOf(id, snapshot) {
  if (/^t\d+$/.test(id)) {
    const t = registry.getTask(id);
    if (!t) return { done: true, why: 'no such task (treated as finished rather than waited on forever)', lastActivityAt: null };
    return { done: TERMINAL_TASK.has(t.status), why: 'task ' + t.status,
             lastActivityAt: Date.parse(t.endedAt || t.startedAt || t.createdAt) || null };
  }
  const s = snapshot && snapshot.sessions && snapshot.sessions.find(x => x.sessionId === id);
  if (!s) return { done: true, why: 'session is not in the sidebar any more (archived or gone)', lastActivityAt: null };
  if (s.isArchived) return { done: true, why: 'session archived', lastActivityAt: null };
  const running = s.isRunning || s.state === 'running';
  return { done: !running, why: running ? 'session still running' : 'session ' + (s.state || 'idle'),
           lastActivityAt: Date.parse(s.lastActivityAt || 0) || null };
}

function tick({ snapshot, at = Date.now() } = {}) {
  const st = load();
  const events = [];
  let changed = false;

  for (const w of st.watches) {
    if (w.resolvedAt) continue;

    if (at >= Date.parse(w.deadlineAt)) {
      w.resolvedAt = iso(at); w.resolution = 'deadline'; changed = true;
      events.push({
        key: `await:${w.id}:deadline`, kind: 'await-deadline',
        masterSessionId: w.masterSessionId, project: w.project,
        line: `WAKE (deadline) you parked on ${w.waitingOn.join(', ')}${w.reason ? ' — ' + w.reason : ''}, and the deadline passed without all of them finishing. Check them yourself; nothing is watching them now.`,
      });
      continue;
    }

    const states = w.waitingOn.map(id => ({ id, ...stateOf(id, snapshot) }));
    const pending = states.filter(x => !x.done);
    if (!pending.length) {
      w.resolvedAt = iso(at); w.resolution = 'complete'; changed = true;
      events.push({
        key: `await:${w.id}:complete`, kind: 'await-complete',
        masterSessionId: w.masterSessionId, project: w.project,
        line: `WAKE everything you parked on has finished: ${states.map(s => s.id + ' (' + s.why + ')').join(', ')}${w.reason ? ' — ' + w.reason : ''}. Read them and carry on.`,
      });
      continue;
    }

    if (!w.nudgedAt) {
      const quiet = pending.filter(x => x.lastActivityAt && (at - x.lastActivityAt) > STALE_AFTER_MS);
      if (quiet.length) {
        w.nudgedAt = iso(at); changed = true;
        events.push({
          key: `await:${w.id}:stale`, kind: 'await-stale',
          masterSessionId: w.masterSessionId, project: w.project,
          line: `STILL WAITING on ${quiet.map(x => x.id + ' (quiet ' + Math.round((at - x.lastActivityAt) / 60000) + ' min)').join(', ')}${w.reason ? ' — ' + w.reason : ''}. Still parked; deadline ${w.deadlineAt}. If that session is stuck, nothing else will notice.`,
        });
      }
    }
  }

  if (changed) save(st);
  return { events, live: st.watches.filter(w => !w.resolvedAt).length };
}

module.exports = { park, cancel, list, watchFor, tick, stateOf,
                   DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, STALE_AFTER_MS, load, save, FILE };
