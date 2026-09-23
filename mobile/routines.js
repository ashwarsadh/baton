'use strict';
const fs = require('fs');
const path = require('path');

const TASKS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'scheduled-tasks');
const META_FILE = path.join(require('../lib/config').STATE, 'routines-meta.json');

function frontmatter(md) {
  const out = { body: md };
  if (!md.startsWith('---')) return out;
  const end = md.indexOf('\n---', 3);
  if (end < 0) return out;
  const head = md.slice(3, end);
  for (const line of head.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  out.body = md.slice(end + 4).replace(/^\s+/, '');
  return out;
}

function displayName(id) {
  const s = String(id || '').replace(/[-_]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function readDisk() {
  let dirs = [];
  try { dirs = fs.readdirSync(TASKS_DIR); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const f = path.join(TASKS_DIR, d, 'SKILL.md');
    let md, st;
    try { md = fs.readFileSync(f, 'utf8'); st = fs.statSync(f); } catch { continue; }
    const fm = frontmatter(md);
    out.push({
      id: d,
      name: displayName(fm.name || d),
      description: fm.description || '',
      prompt: fm.body || '',
      promptUpdatedAt: st.mtimeMs,
      path: f,
    });
  }
  return out;
}

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return { at: null, tasks: {} }; }
}
function saveMeta(meta) {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  const tmp = META_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
  fs.renameSync(tmp, META_FILE);
}

function field(spec, min, max) {
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return null;
    let lo = m[1] === '*' ? min : Number(m[1]);
    let hi = m[1] === '*' ? max : (m[2] != null ? Number(m[2]) : lo);
    const step = m[3] != null ? Number(m[3]) : 1;
    if (!(lo >= min && hi <= max && lo <= hi && step > 0)) return null;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

function parseCron(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) return null;
  const f = [field(p[0], 0, 59), field(p[1], 0, 23), field(p[2], 1, 31), field(p[3], 1, 12), field(p[4], 0, 7)];
  if (f.some(x => !x)) return null;
  if (f[4].has(7)) f[4].add(0);
  return { min: f[0], hour: f[1], dom: f[2], mon: f[3], dow: f[4], domAny: p[2] === '*', dowAny: p[4] === '*' };
}

function nextCron(expr, from = new Date()) {
  const c = parseCron(expr);
  if (!c) return null;
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 400 * 86400000;
  while (t.getTime() < limit) {
    if (!c.mon.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
    const domOk = c.dom.has(t.getDate()), dowOk = c.dow.has(t.getDay());
    const dayOk = (c.domAny && c.dowAny) ? true : c.domAny ? dowOk : c.dowAny ? domOk : (domOk || dowOk);
    if (!dayOk) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1); continue; }
    return t;
  }
  return null;
}

function list(sessions = [], now = new Date()) {
  const meta = loadMeta();
  const byTitle = new Map();
  for (const s of sessions) {
    const k = String(s.title || '').trim().toLowerCase();
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(s);
  }

  const out = readDisk().map(r => {
    const m = (meta.tasks && meta.tasks[r.id]) || {};
    let next = null;
    if (m.enabled !== false) {
      if (m.cronExpression) { const n = nextCron(m.cronExpression, now); next = n ? n.toISOString() : null; }
      else if (m.fireAt && Date.parse(m.fireAt) > now.getTime()) next = m.fireAt;
    }
    const runs = (byTitle.get(r.name.toLowerCase()) || [])
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
      .slice(0, 12)
      .map(s => ({ id: s.id, at: s.lastActivityAt || 0, dot: s.dot || null, running: !!s.running, unread: !!s.unread }));
    const kind = m.cronExpression ? 'recurring' : m.fireAt ? 'once' : (m.id || meta.tasks && meta.tasks[r.id]) ? 'manual' : 'unknown';
    return {
      id: r.id, name: r.name, description: r.description,
      schedule: m.schedule || (m.cronExpression ? m.cronExpression : m.fireAt ? 'One-time' : kind === 'manual' ? 'Manual only' : null),
      cronExpression: m.cronExpression || null,
      enabled: m.enabled === undefined ? null : !!m.enabled,
      kind,
      nextRunAt: next,
      lastRunAt: m.lastRunAt || (runs[0] ? new Date(runs[0].at).toISOString() : null),
      runs,
      promptUpdatedAt: r.promptUpdatedAt,
      promptChars: r.prompt.length,
    };
  });

  out.sort((a, b) => {
    const an = a.nextRunAt ? Date.parse(a.nextRunAt) : Infinity;
    const bn = b.nextRunAt ? Date.parse(b.nextRunAt) : Infinity;
    if (an !== bn) return an - bn;
    return Date.parse(b.lastRunAt || 0) - Date.parse(a.lastRunAt || 0);
  });
  return { ok: true, at: meta.at || null, routines: out };
}

function prompt(id) {
  const r = readDisk().find(x => x.id === id);
  return r ? { ok: true, id, name: r.name, prompt: r.prompt } : { ok: false, error: 'NO_SUCH_ROUTINE' };
}

module.exports = { list, prompt, loadMeta, saveMeta, nextCron, parseCron, displayName, TASKS_DIR, META_FILE };
