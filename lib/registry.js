'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = require('./config').DATA;
const STATE_DIR = process.env.BATON_STATE_DIR || path.join(ROOT, 'state');
const RESULTS_DIR = process.env.BATON_STATE_DIR
  ? path.join(process.env.BATON_STATE_DIR, 'results')
  : path.join(ROOT, 'results');
const FILE = path.join(STATE_DIR, 'registry.json');

const EMPTY = { version: 1, tasks: {}, seq: 0, updatedAt: null };

function renameWithRetry(from, to, tries = 8) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (i >= tries - 1 || !/EPERM|EBUSY|EACCES/.test(String(e.code))) throw e;
      const until = Date.now() + 25 * (i + 1);
      while (Date.now() < until) { }
    }
  }
}

function ensureDirs() {
  for (const d of [ROOT, STATE_DIR, RESULTS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}

let _cache = null;
let _tmpSeq = 0;

function load() {
  ensureDirs();
  try {
    const st = fs.statSync(FILE);
    if (_cache && _cache.mtimeMs === st.mtimeMs && _cache.size === st.size) return _cache.data;
    const raw = fs.readFileSync(FILE, 'utf8');
    if (raw.trim()) {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && j.tasks) { _cache = { mtimeMs: st.mtimeMs, size: st.size, data: j }; return j; }
    }
  } catch { }
  _cache = null;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    if (!raw.trim()) return { ...EMPTY };
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.tasks) return { ...EMPTY };
    return j;
  } catch {
    try {
      if (fs.existsSync(FILE)) fs.renameSync(FILE, FILE + '.corrupt-' + Date.now());
    } catch {}
    return { ...EMPTY };
  }
}

function save(state) {
  _cache = null;
  ensureDirs();
  state.updatedAt = new Date().toISOString();
  const tmp = FILE + '.' + process.pid + '.' + (++_tmpSeq) + '.tmp';
  const data = JSON.stringify(state, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(tmp, FILE);
  return state;
}

function nextId(state) {
  state.seq = (state.seq || 0) + 1;
  return 't' + String(state.seq).padStart(4, '0');
}

function createTask(fields) {
  const state = load();
  const id = nextId(state);
  const now = new Date().toISOString();
  const task = {
    id,
    title: fields.title || (fields.prompt || '').slice(0, 60),
    prompt: fields.prompt || '',
    cwd: fields.cwd || process.cwd(),
    type: fields.type || 'unknown',
    complexity: fields.complexity || 'unknown',
    model: fields.model || null,
    effort: fields.effort || null,
    lean: !!fields.lean,
    mode: fields.mode || 'worker',
    dispatch: fields.dispatch || null,
    masterId: fields.masterId || null,
    guiSessionId: null,
    tokensReported: null,
    launchFailed: false,
    sessionId: fields.sessionId || null,
    reuseOf: fields.reuseOf || null,
    isolate: !!fields.isolate,
    status: 'queued',
    attempt: 0,
    maxAttempts: fields.maxAttempts == null ? 3 : fields.maxAttempts,
    pid: null,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    result: null,
    error: null,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    escalations: [],
    logFile: null,
    resultFile: null,
    dependsOn: fields.dependsOn || [],
    tags: fields.tags || [],
  };
  state.tasks[id] = task;
  save(state);
  return task;
}

function updateTask(id, patch) {
  const state = load();
  const t = state.tasks[id];
  if (!t) return null;
  Object.assign(t, patch);
  save(state);
  return t;
}

function getTask(id) { return load().tasks[id] || null; }

function allTasks() {
  const state = load();
  return Object.values(state.tasks).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function byStatus(status) { return allTasks().filter(t => t.status === status); }

function prune(days = 14) {
  const state = load();
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const [id, t] of Object.entries(state.tasks)) {
    const done = ['done', 'failed', 'cancelled'].includes(t.status);
    const when = Date.parse(t.endedAt || t.createdAt || 0);
    if (done && when && when < cutoff) { delete state.tasks[id]; removed++; }
  }
  if (removed) save(state);
  return removed;
}

module.exports = { ROOT, STATE_DIR, RESULTS_DIR, FILE, load, save, createTask, updateTask, getTask, allTasks, byStatus, prune, ensureDirs };
