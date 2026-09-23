'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const bridge = require('../lib/bridge');
const orch = require('../lib/orchestrator');
const desktop = require('../lib/desktop');
const sessions = require('./sessions');
const resume = require('../lib/resume');

const config = require('../lib/config');
const CONDUCTOR_DIR = (config.get().board && config.get().board.dir) || path.join(config.DATA, 'board');
const BOARD_JSON = path.join(CONDUCTOR_DIR, 'board.json');
const INDEX_MD = path.join(CONDUCTOR_DIR, 'INDEX.md');
const AUDIT = path.join(CONDUCTOR_DIR, 'board-actions.jsonl');
const ACTED = path.join(require('../lib/config').STATE, 'board-acted.json');
const ACTED_TTL_MS = 12 * 3600 * 1000;

const log = (m) => { try { orch.log('[board] ' + m); } catch { console.log('[board] ' + m); } };

function readBoard() {
  let raw;
  try { raw = fs.readFileSync(BOARD_JSON, 'utf8'); }
  catch (e) {
    return { ok: false, error: 'no-board', detail: e.code === 'ENOENT'
      ? 'board.json not found in ' + CONDUCTOR_DIR + ' (see docs/BOARD.md for the format)'
      : e.message };
  }
  try { return Object.assign({ ok: true }, JSON.parse(raw)); }
  catch (e) { return { ok: false, error: 'bad-board', detail: e.message }; }
}

function conductorId(board) {
  if (config.get().conductorSession) return config.get().conductorSession;
  try {
    const first = fs.readFileSync(INDEX_MD, 'utf8').split(/\r?\n/, 1)[0] || '';
    const m = first.match(/^Conductor id:\s*(\S+)\s*$/);
    if (m && m[1] && m[1] !== 'unknown') return m[1];
  } catch {}
  const b = board || readBoard();
  return (b && b.conductor) || null;
}

function registryRow(sessionId) {
  const want = 'local_' + String(sessionId).replace(/^local_/, '') + '.json';
  let root;
  try { root = resume.registryRoot(); } catch { return null; }
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      if (e.name !== want) continue;
      let j; try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!j || !j.sessionId) continue;
      const row = { sessionId: j.sessionId, title: j.title || '', error: j.error || null,
                    errorAt: Number(j.errorAt) || null, isArchived: !!j.isArchived,
                    lastActivityAt: Number(j.lastActivityAt) || 0 };
      if (!best || row.lastActivityAt > best.lastActivityAt ||
          (row.lastActivityAt === best.lastActivityAt && (row.errorAt || 0) > (best.errorAt || 0))) best = row;
    }
  };
  walk(root, 0);
  return best;
}

const INBOX_JSONL = path.join(CONDUCTOR_DIR, 'inbox.jsonl');
let noteCache = { mtime: 0, size: -1, map: new Map() };
function liveNotes() {
  let st;
  try { st = fs.statSync(INBOX_JSONL); } catch { return noteCache.map; }
  if (st.mtimeMs === noteCache.mtime && st.size === noteCache.size) return noteCache.map;
  const map = new Map();
  try {
    for (const line of fs.readFileSync(INBOX_JSONL, 'utf8').split(String.fromCharCode(10))) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r || r.n === undefined) continue;
      map.set(String(r.n), typeof r.note === 'string' ? r.note : '');
    }
  } catch { return noteCache.map; }
  noteCache = { mtime: st.mtimeMs, size: st.size, map };
  return map;
}

let stCache = { at: 0, val: null };

async function conductorState(board, opts) {
  if (!(opts && opts.fresh) && stCache.val && Date.now() - stCache.at < 15000) return stCache.val;
  const val = computeConductorState(board);
  stCache = { at: Date.now(), val };
  return val;
}

function computeConductorState(board) {
  const id = conductorId(board);
  if (!id) return { id: null, ok: false, reason: 'No Conductor session is claimed — set one in Settings > Conductor, or add "conductor" to board.json.' };

  let row = null, snapAt = null;
  try {
    const snap = desktop.loadSnapshot() || {};
    snapAt = snap.at || null;
    row = (snap.sessions || []).find(r => r.sessionId === id) || null;
  } catch {}
  if (!row) return { id, ok: false, reason: 'The Conductor session is not in the Claude Desktop sidebar.', at: snapAt };
  if (row.isArchived) return { id, ok: false, reason: 'The Conductor session is archived.', at: snapAt };

  let reg = null;
  try { reg = registryRow(id); } catch {}
  if (reg && reg.error) {
    return { id, ok: false, at: snapAt, reason: 'The Conductor is stopped: ' + String(reg.error).slice(0, 160) };
  }
  return { id, ok: true, at: snapAt, reason: row.running ? 'running — the line will queue behind its turn' : 'idle' };
}

function composeLine(cmd, id, title, extra) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const x = extra ? String(extra).replace(/[\r\n]+/g, ' ').trim() : '';
  return cmd + ' ' + id + (x ? ': ' + x : '') + '   # ' + t.slice(0, 50);
}

const inboxTitle = (r) => '#' + r.n + ' ' + String(r.text || '').slice(0, 300);

const KINDS = new Set(['yes', 'skip', 'answer', 'done']);

function lineFor(board, kind, id, text) {
  if (!KINDS.has(kind)) return { ok: false, error: 'bad-kind', detail: 'kind must be yes | skip | answer | done' };
  const raw = String(id == null ? '' : id).trim();
  if (!raw) return { ok: false, error: 'no-id' };

  const n = raw.startsWith('#') ? raw.slice(1) : raw;
  const item = /^\d+$/.test(n) && (board.inbox || []).find(r => String(r.n) === n);
  if (item) {
    if (kind === 'yes' || kind === 'skip') {
      return { ok: false, error: 'bad-kind', detail: 'inbox items take Done or Answer, not ' + kind };
    }
    const title = inboxTitle(item);
    if (kind === 'done') return { ok: true, line: composeLine('done', '#' + item.n, title), target: 'inbox', title };
    if (!String(text || '').trim()) return { ok: false, error: 'no-text', detail: 'answer needs text' };
    return { ok: true, line: composeLine('answer', '#' + item.n, title, text), target: 'inbox', title };
  }

  const row = (board.rows || []).find(r => r.id === raw);
  if (!row) return { ok: false, error: 'unknown-id', detail: raw + ' is not on the current board' };
  if (kind === 'done') return { ok: false, error: 'bad-kind', detail: 'Done is for inbox items; a session takes yes / skip / answer' };
  if (kind === 'answer' && !String(text || '').trim()) return { ok: false, error: 'no-text', detail: 'answer needs text' };
  return {
    ok: true,
    line: composeLine(kind, row.id, row.title, kind === 'answer' ? text : ''),
    target: 'session', title: row.title,
  };
}

const SEND_TIMEOUT_MS = 20000;

function withTimeout(p, ms, why) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rj) => { t = setTimeout(() => rj(new Error(why)), ms); }),
  ]);
}

function readActed() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(ACTED, 'utf8')) || {}; } catch {}
  const now = Date.now(), out = {};
  for (const [id, r] of Object.entries(raw)) {
    if (r && r.at && now - r.at < ACTED_TTL_MS) out[id] = r;
  }
  return out;
}

function writeActed(map) {
  try {
    fs.mkdirSync(path.dirname(ACTED), { recursive: true });
    fs.writeFileSync(ACTED, JSON.stringify(map), 'utf8');
  } catch (e) { log('acted write failed: ' + e.message); }
}

function recordActed(id, kind) {
  const m = readActed();
  m[String(id)] = { kind, at: Date.now() };
  writeActed(m);
}

function unhide(id) {
  const m = readActed();
  const had = Object.prototype.hasOwnProperty.call(m, String(id));
  delete m[String(id)];
  writeActed(m);
  return had;
}

function audit(rec) {
  try {
    fs.mkdirSync(CONDUCTOR_DIR, { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { log('audit write failed: ' + e.message); }
}

async function act({ kind, id, text, who }) {
  const board = readBoard();
  if (!board.ok) return { code: 503, body: { ok: false, error: board.error, detail: board.detail } };

  const l = lineFor(board, kind, id, text);
  if (!l.ok) return { code: 400, body: l };

  const st = await conductorState(board, { fresh: true });
  if (!st.ok) {
    audit({ at: new Date().toISOString(), kind, id, line: l.line, who: who || 'mobile', result: 'refused', reason: st.reason });
    return { code: 429, body: { ok: false, error: 'conductor-unavailable', reason: st.reason, conductor: st.id, line: l.line } };
  }

  const message = '[board] ' + l.line;
  let out;
  try {
    out = await withTimeout(bridge.sendMessage(st.id, message, {
      origin: { kind: 'peer', sessionId: 'baton-mobile-board' },
      initiator: 'baton-mobile-board',
    }), SEND_TIMEOUT_MS, 'the bridge did not answer in ' + (SEND_TIMEOUT_MS / 1000) + 's');
  } catch (e) {
    out = { ok: false, error: 'SEND_THREW', reason: e.message };
  }

  const rec = {
    at: new Date().toISOString(), kind, id, target: l.target, line: l.line, message,
    conductor: st.id, who: who || 'mobile',
    result: out.ok ? (out.delivered ? 'delivered' : 'queued') : 'failed',
    reason: out.reason || out.error || null,
  };
  audit(rec);
  log(rec.result + ': ' + l.line);
  if (out.ok) recordActed(id, kind);

  if (!out.ok) {
    return { code: 429, body: { ok: false, error: 'send-failed', reason: rec.reason || 'the send did not complete', line: l.line, conductor: st.id } };
  }
  return { code: 200, body: { ok: true, line: l.line, message, delivered: !!out.delivered, queued: !!out.queued, conductor: st.id, at: rec.at } };
}

async function view() {
  const board = readBoard();
  if (!board.ok) return { code: 503, body: board };
  let st;
  try { st = await conductorState(board); }
  catch (e) { st = { id: board.conductor || null, ok: false, reason: 'Conductor check failed: ' + e.message }; }
  let recent = [];
  try {
    recent = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-60)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.result !== 'refused')
      .map(r => ({ at: r.at, id: String(r.id), kind: r.kind, result: r.result }));
  } catch {}
  const actedMap = readActed();
  const mark = (row, key) => {
    const a = actedMap[String(key)];
    return a ? Object.assign({}, row, { acted: { kind: a.kind, at: new Date(a.at).toISOString() } }) : row;
  };

  const rows = (board.rows || []).map(r => {
    let openable = false;
    try { openable = !!sessions.get(r.id); } catch {}
    return mark(Object.assign({}, r, { openable }), r.id);
  });
  const notes = liveNotes();
  const inbox = (board.inbox || []).map(r => {
    let openable = false;
    if (r.session) { try { openable = !!sessions.get(r.session); } catch {} }
    const live = notes.get(String(r.n));
    const note = live === undefined ? (r.note || '') : live;
    return mark(Object.assign({}, r, { openable, note }), '#' + r.n);
  });

  const counts = {};
  for (const b of ['buried', 'decide', 'nudge', 'un', 'open']) {
    counts[b] = rows.filter(r => r.bucket === b && !r.handled && !r.acted && (r.age == null || r.age <= 7)).length;
  }

  return {
    code: 200,
    body: {
      ok: true, built_at: board.built_at, counts, builtCounts: board.counts, projects: board.projects,
      labels: board.labels, hints: board.hints, rows, inbox,
      goals: (board.goals || []).map(g => ({
        id: g.id, title: g.title, status: g.status || 'open', due: g.due || null,
        session: g.session || null, blocked_on: g.blocked_on || null,
        checks: Array.isArray(g.checks) ? g.checks : [],
        progress: g.progress || null, outcome: g.outcome || null,
        detail: String(g.detail || '').slice(0, 400),
      })),
      conductor: { id: st.id, ok: st.ok, reason: st.reason, at: st.at || null },
      recent,
    },
  };
}

module.exports = { view, act, unhide, readActed, readBoard, liveNotes, conductorId, conductorState, composeLine, lineFor, BOARD_JSON, AUDIT };
