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
  const home = process.env.USERPROFILE || require('os').homedir();
  const targets = new Set([
    home,
    path.join(home, '.claude'),
    require('./config').DATA,
    require('./config').RESULTS,
    process.cwd(),
    ...extra.filter(Boolean),
  ]);

  // Optional user-configured project roots (settings.trustedRoots: string[], Settings › Advanced).
  // Each entry's immediate subdirectories are trusted for headless workers, the same as a project
  // folder the user picks by hand. Default [] — nothing beyond the folders above is trusted.
  const { roots, refused } = trustedRoots();
  for (const root of roots) {
    try {
      for (const d of fs.readdirSync(root)) {
        const full = path.join(root, d);
        try { if (fs.statSync(full).isDirectory()) targets.add(full); } catch {}
      }
    } catch {}
  }

  return { ...trustPaths([...targets]), refusedRoots: refused };
}

/**
 * settings.trustedRoots, checked. A root must be an absolute folder, and never a filesystem root
 * ("C:\", "/"): trusting every top-level folder of a drive would hand workers the whole machine.
 */
function trustedRoots(list = require('./config').get().trustedRoots) {
  const roots = [], refused = [];
  for (const raw of (Array.isArray(list) ? list : String(list || '').split(/[\n;]+/))) {
    const r = String(raw || '').trim();
    if (!r) continue;
    if (!path.isAbsolute(r)) { refused.push({ root: r, why: 'not an absolute path' }); continue; }
    const abs = path.resolve(r);
    if (path.parse(abs).root === abs || abs === path.parse(abs).root.replace(/[\\/]+$/, '')) { refused.push({ root: r, why: 'a filesystem root is too broad' }); continue; }
    roots.push(abs);
  }
  return { roots, refused };
}

module.exports = { trustPaths, isTrusted, ensureDefaultTrust, trustedRoots, CONFIG, AUTH_DIR };
