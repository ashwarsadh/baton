'use strict';
const fs = require('fs');
const path = require('path');

const AUTH_DIR = require('./config').AUTH;
const CONFIG = path.join(AUTH_DIR, '.claude.json');

function normalise(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function trustPaths(paths) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  cfg.projects = cfg.projects || {};

  let added = 0;
  for (const raw of paths) {
    const key = normalise(raw);
    if (!key) continue;
    const existing = cfg.projects[key] || {};
    if (existing.hasTrustDialogAccepted === true) continue;
    cfg.projects[key] = { ...existing, hasTrustDialogAccepted: true };
    added++;
  }

  if (added) {
    try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch {}
    const tmp = CONFIG + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(cfg, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, CONFIG);
  }
  return { added, total: Object.keys(cfg.projects).length, file: CONFIG };
}

function isTrusted(p) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const e = (cfg.projects || {})[normalise(p)];
    return !!(e && e.hasTrustDialogAccepted);
  } catch { return false; }
}

function ensureDefaultTrust(extra = []) {
  const home = process.env.USERPROFILE || '';
  const targets = new Set([
    home,
    path.join(home, '.claude'),
    require('./config').DATA,
    require('./config').RESULTS,
    process.cwd(),
    ...extra.filter(Boolean),
  ]);

  // Optional user-configured project roots (settings.trustedRoots: string[]). Each entry's
  // immediate subdirectories are trusted, same as a project root the user picks by hand.
  const trustedRoots = (require('./config').get().trustedRoots || []).filter(Boolean);
  for (const root of trustedRoots) {
    try {
      for (const d of fs.readdirSync(root)) {
        const full = path.join(root, d);
        try { if (fs.statSync(full).isDirectory()) targets.add(full); } catch {}
      }
    } catch {}
  }

  return trustPaths([...targets]);
}

module.exports = { trustPaths, isTrusted, ensureDefaultTrust, CONFIG, AUTH_DIR };
