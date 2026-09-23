'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The owner index is an optional external directory (settings.ownerIndex) that lists which
// session owns which topic. Blank/unset disables this feature entirely: every lookup below
// returns a harmless "no index" result instead of throwing.
function ownerIndexDir() {
  return String(require('./config').get().ownerIndex || '').trim();
}
function indexPaths() {
  const dir = ownerIndexDir();
  if (!dir) return null;
  return {
    dir,
    json: path.join(dir, 'index.json'),
    md: path.join(dir, 'INDEX.md'),
    roles: process.env.BATON_ROLES_JSON || path.join(dir, 'roles.json'),
  };
}

const KEEPER_RE = /\bkeeper\b|\bkeeps?\b.{0,40}\b(skill|skills|true|current|accurate|honest)\b|\bkeep\b.{0,40}\bskills?\b|\bskills?\b.{0,20}\b(keeper|true|current|up to date)\b|master of masters|\bconductor\b.{0,20}(routing|index|master)|\bindex\b.{0,15}\bbuilder\b/i;

const SCRATCH_RE = /\bscratch\b|\btest session\b|\btooling test\b|\bregression test scratch\b/i;

const STOP = new Set(('the a an and or of to in on for with is are be was were it its this that they them'
  + ' i you we he she his her our your their not no yes do does did done shall should would could can'
  + ' will make made making use used using new old fix fixed fixing please also can t dont don why how'
  + ' what when where which who whom about from into over under again more most some any all each'
  + ' session sessions message messages send sending sent').split(/\s+/));

const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9_.-]{2,}/g) || [];
const stem = (t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) ? t.slice(0, -1) : t;
const contentTokens = (s) => tokens(s).flatMap(t => t.includes('-') ? [t, ...t.split('-')] : [t])
  .filter(t => !STOP.has(t) && t.length > 2).map(stem);

function readIndex() {
  const p = indexPaths();
  if (!p) return null;
  try { return JSON.parse(fs.readFileSync(p.json, 'utf8')); } catch {}
  try {
    const md = fs.readFileSync(p.md, 'utf8');
    const sessions = {};
    for (const line of md.split(/\r?\n/)) {
      const m = /^-\s+([0-9a-f]{8})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (!m) continue;
      const id = (/#(local_[0-9a-f-]{36})/.exec(line) || [])[1];
      if (!id) continue;
      sessions[id] = { id, title: m[2], group: m[3], tags: (line.match(/#[a-z0-9_-]+/gi) || []).map(t => t.slice(1)) };
    }
    return { sessions, projects: {}, baton_masters: {}, _from: 'INDEX.md' };
  } catch {}
  return null;
}

const KEEPER_TOPIC_RE = /\b(skills?|skill file|SKILL\.md|documentation|docs?)\b[\s\S]{0,60}\b(update|updating|edit|correct|accurate|true|current|stale|wrong|add|maintain)\b|\b(update|edit|correct|fix|add to|maintain)\b[\s\S]{0,40}\b(skills?|SKILL\.md|docs?|documentation)\b|\bkeep\b[\s\S]{0,40}\b(skills?|docs?)\b/i;

let _roles = { mtime: 0, sessions: {}, idf: null };
function readRoles() {
  const p = indexPaths();
  if (!p) return {};
  try {
    const m = fs.statSync(p.roles).mtimeMs;
    if (m !== _roles.mtime) _roles = { mtime: m, sessions: JSON.parse(fs.readFileSync(p.roles, 'utf8')).sessions || {}, idf: null };
    return _roles.sessions;
  } catch { return {}; }
}

const strongText = (rec) => [...(rec.owns_topics || []), ...Object.values(rec.open_goals || {})].join(' ');

function idfFor(roles) {
  if (roles === _roles.sessions && _roles.idf) return _roles.idf;
  const df = new Map();
  const recs = Object.values(roles);
  for (const r of recs) for (const t of new Set(contentTokens(strongText(r) + ' ' + (r.role || '')))) df.set(t, (df.get(t) || 0) + 1);
  const N = recs.length || 1;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) / Math.log(N + 1);
  if (roles === _roles.sessions) _roles.idf = idf;
  return idf;
}

function phraseHit(phrase, want) {
  const w = [...new Set(contentTokens(phrase))];
  const n = w.filter(t => want.tokens.has(t)).length;
  return { n, len: w.length, full: w.length > 0 && n >= Math.max(1, Math.ceil(w.length / 2)) };
}

function scoreRole(rec, want, topic, roles) {
  const idf = idfFor(roles || readRoles());
  const why = [];
  const owns = new Set(contentTokens((rec.owns_topics || []).join(' ')));
  const goals = new Set(contentTokens(Object.values(rec.open_goals || {}).join(' ')));
  const weak = new Set(contentTokens(rec.role));
  let s1 = 0, s3 = 0, s2 = 0, hits = 0;
  for (const t of want.tokens) {
    if (owns.has(t)) { s1 += 16 * idf(t); hits++; }
    else if (goals.has(t)) { s3 += 10 * idf(t); hits++; }
    else if (weak.has(t)) { s2 += 6 * idf(t); hits++; }
  }
  let score = Math.min(s1, 64) + Math.min(s3, 30) + Math.min(s2, 18);
  for (const ph of rec.owns_topics || []) if (phraseHit(ph, want).full) why.push(`DB owns "${ph}"`);
  for (const [g, title] of Object.entries(rec.open_goals || {})) if (phraseHit(title, want).n >= 2) why.push(`DB open goal ${g}`);
  if (s2) why.push('topic words in DB role');
  const topicLc = String(topic || '').toLowerCase();
  for (const g of [...new Set([...(rec.owns_goals || []), ...Object.keys(rec.open_goals || {})])]) {
    if (g && new RegExp('\b' + String(g).toLowerCase() + '\b').test(topicLc)) { score += 40; hits++; why.push('DB owns goal ' + g); }
  }
  for (const f of rec.owns_files || []) {
    const base = String(f).toLowerCase().split(/[\/]/).pop();
    if (base && base.length > 3 && topicLc.includes(base)) { score += 20; hits++; why.push('DB owns file ' + base); }
  }
  const raw = new Set(tokens(topic).filter(t => !STOP.has(t) && t.length > 2).map(stem));
  for (const ph of rec.not_owns || []) {
    const w = [...new Set(tokens(ph).filter(t => !STOP.has(t) && t.length > 2).map(stem))];
    const h = { n: w.filter(t => raw.has(t)).length, len: w.length };
    if ((h.len === 1 && h.n === 1) || (h.n >= 2 && h.n >= Math.ceil(h.len * 2 / 3))) { score -= 40; why.push(`DB: does NOT own "${ph}"`); }
  }
  return { score: Math.round(score), hits, why };
}

function disqualify(s) {
  if (s.archived) return 'archived';
  if (KEEPER_RE.test(String(s.title || ''))) return 'keeper/skill-owner — owns a document, not a lane';
  if (s.skills && Object.keys(s.skills).length && /\b(skill|doc|documentation|memory|index)\b/i.test(String(s.title || ''))) {
    return 'maintains a skill/doc';
  }
  return null;
}

function scoreSession(s, want, rec, topic) {
  const proj = String(s.project || '').toLowerCase();
  const group = String(s.group || '').toLowerCase();
  let score = 0;
  const why = [];

  if (want.project && proj && proj === want.project) { score += 50; why.push('project=' + proj); }
  else if (want.project && proj && (proj.includes(want.project) || want.project.includes(proj))) { score += 30; why.push('project~' + proj); }

  if (want.group && group && group === want.group) { score += 12; why.push('group=' + s.group); }

  let hits = 0;
  if (rec) {
    const r = scoreRole(rec, want, topic, want.roles);
    score += r.score; hits += r.hits; why.push(...r.why);
  }
  const hay = new Set(contentTokens([s.title, (s.tags || []).join(' '), s.first_prompt, s.summary].join(' ')));
  let th = 0;
  for (const t of want.tokens) if (hay.has(t)) th++;
  if (th) { score += th * (rec ? 3 : 9); hits += th; why.push(th + ' topic word' + (th === 1 ? '' : 's') + ' in title/tags' + (rec ? ' (tie-break)' : '')); }

  if (score && !hits && !want.projectExplicit) score = Math.min(score, 18);

  if (s.is_master || s.baton_master || (rec && rec.is_master)) { score += 8; why.push('master of its lane'); }
  if (SCRATCH_RE.test(String(s.title || ''))) { score -= 25; why.push('scratch/test session'); }

  const ageDays = Number(s.age_days);
  if (Number.isFinite(ageDays)) {
    if (ageDays <= 2) { score += 6; why.push('active in the last 2 days'); }
    else if (ageDays > 21) { score -= 6; why.push('quiet for ' + Math.round(ageDays) + ' days'); }
  }
  if (s.running) { score += 3; why.push('running'); }

  return { score, why };
}

function projectFromTopic(topic, ix) {
  const t = ' ' + String(topic || '').toLowerCase().replace(/[^a-z0-9_. -]+/g, ' ') + ' ';
  const names = [...new Set(Object.values(ix.sessions || {})
    .map(s => String(s.project || '').toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const n of names) {
    const k = n.toLowerCase();
    if (k.length < 3) continue;
    if (t.includes(' ' + k + ' ') || t.includes(' ' + k + "'s ")) return k;
  }
  return null;
}

function resolve(topic, opts = {}) {
  const ix = readIndex();
  if (!ix) return { ok: false, noIndex: true, refusal: 'no owner index configured (set ownerIndex in settings) — cannot resolve an owner' };

  const explicit = String(opts.project || '').toLowerCase() || null;
  const want = {
    tokens: new Set(contentTokens(topic)),
    project: explicit || projectFromTopic(topic, ix),
    group: String(opts.group || '').toLowerCase() || null,
    projectExplicit: !!explicit,
  };

  const keeperTopic = KEEPER_TOPIC_RE.test(String(topic || ''));

  const roles = opts.roles || readRoles();
  want.roles = roles;
  const rows = [];
  for (const s of Object.values(ix.sessions || {})) {
    if (opts.exclude && s.id === opts.exclude) continue;
    const bad = disqualify(s);
    if (bad && !(keeperTopic && bad !== 'archived')) { rows.push({ id: s.id, title: s.title, excluded: bad }); continue; }
    let { score, why } = scoreSession(s, want, roles[s.id] || null, topic);
    if (keeperTopic && bad) { score += 25; why = why.concat('keeper, and this topic IS skill/doc upkeep'); }
    if (score <= 0) continue;
    rows.push({ id: s.id, title: s.title, project: s.project, group: s.group, score, why, role: roles[s.id] ? roles[s.id].role : null });
  }

  const ranked = rows.filter(r => r.score > 0).sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const runnerUp = ranked[1] || null;

  const MIN = 30;
  if (!best || best.score < MIN) {
    return {
      ok: false,
      noOwner: true,
      project: want.project,
      spawn: {
        why: best ? `best candidate "${best.title}" scored ${best.score}, under the bar of ${MIN}`
                  : 'nothing in the index matched this topic at all',
        project: want.project || null,
        group: want.project ? groupForProject(ix, want.project) : null,
        hint: 'baton_spawn with this project/group, then send the topic verbatim to the new session',
      },
      candidates: ranked.slice(0, 5),
      excluded: rows.filter(r => r.excluded).slice(0, 5),
    };
  }

  return {
    ok: true,
    owner: best.id,
    title: best.title,
    role: best.role || null,
    project: best.project,
    group: best.group,
    score: best.score,
    why: best.why,
    runnerUp: runnerUp ? { id: runnerUp.id, title: runnerUp.title, score: runnerUp.score } : null,
    close: !!(runnerUp && best.score - runnerUp.score <= 8),
    candidates: ranked.slice(0, 5),
  };
}

function groupForProject(ix, project) {
  const counts = Object.create(null);
  for (const s of Object.values(ix.sessions || {})) {
    if (String(s.project || '').toLowerCase() !== project || !s.group || s.archived) continue;
    counts[s.group] = (counts[s.group] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function check(topic, targetId, opts = {}) {
  const r = resolve(topic, opts);
  if (r.ok && r.owner === targetId) return { ok: true, allow: true, owner: r.owner, why: r.why };

  const ix = readIndex() || { sessions: {} };
  const t = (ix.sessions || {})[targetId] || null;
  const bad = (t && !KEEPER_TOPIC_RE.test(String(topic || ''))) ? disqualify(t) : null;
  return {
    ok: true,
    allow: false,
    refusal: bad
      ? `${targetId} is a ${bad}. It can only decline and route the topic back — send project work to the actual owner instead.`
      : (r.ok ? `${targetId} is not the owner of this topic; ${r.owner} is ("${r.title}").`
              : 'no session owns this topic — start one rather than sending it to the nearest match'),
    owner: r.ok ? r.owner : null,
    ownerTitle: r.ok ? r.title : null,
    spawn: r.spawn || null,
    candidates: r.candidates || [],
  };
}

module.exports = { resolve, check, disqualify, readIndex, readRoles, scoreRole, KEEPER_RE };
