'use strict';
const fs = require('fs');
const path = require('path');

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_BIN = 8 * 1024 * 1024;

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.csv', '.tsv', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.cs', '.php', '.sh', '.bash', '.ps1', '.bat', '.sql', '.html', '.htm',
  '.css', '.scss', '.xml', '.env', '.gitignore', '.diff', '.patch',
]);
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
                    '.bmp': 'image/bmp', '.ico': 'image/x-icon' };

function realish(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function inside(child, parent) {
  const c = realish(child).toLowerCase();
  const p = realish(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function readFile(ref, { roots = [], cwd = null } = {}) {
  const raw = String(ref || '').trim().replace(/^['"`]|['"`]$/g, '');
  if (!raw) return { ok: false, error: 'NO_PATH' };

  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  const bare = m && !/^[A-Za-z]:$/.test(m[1]) ? m[1] : raw;
  const line = m && !/^[A-Za-z]:$/.test(m[1]) ? Number(m[2]) : null;

  const candidates = [];
  if (path.isAbsolute(bare)) candidates.push(bare);
  else {
    if (cwd) candidates.push(path.resolve(cwd, bare));
    for (const r of roots) candidates.push(path.resolve(r, bare));
  }

  const allowed = roots.filter(Boolean);
  let target = null;
  for (const c of candidates) {
    if (!allowed.some(r => inside(c, r))) continue;
    if (fs.existsSync(c)) { target = c; break; }
    if (!target) target = c;
  }
  if (!target) return { ok: false, error: 'OUT_OF_SCOPE',
                        message: 'That path is outside every folder this machine has worked in.' };

  let st;
  try { st = fs.statSync(target); }
  catch { return { ok: false, error: 'NOT_FOUND', path: target,
                   message: 'No such file. It may not have been written yet.' }; }
  if (st.isDirectory()) {
    let entries = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
        .slice(0, 300)
        .map(e => ({ name: e.name, dir: e.isDirectory() }));
    } catch {}
    return { ok: true, kind: 'dir', path: target, entries };
  }

  const ext = path.extname(target).toLowerCase();
  if (IMAGE_EXT[ext]) {
    if (st.size > MAX_BIN) return { ok: false, error: 'TOO_LARGE', path: target, bytes: st.size };
    const b64 = fs.readFileSync(target).toString('base64');
    return { ok: true, kind: 'image', path: target, bytes: st.size,
             dataUrl: `data:${IMAGE_EXT[ext]};base64,${b64}` };
  }

  const looksText = TEXT_EXT.has(ext) || !ext;
  if (!looksText) return { ok: false, error: 'UNSUPPORTED', path: target, bytes: st.size,
                           message: `${ext || 'This file type'} cannot be shown here.` };
  if (st.size > MAX_TEXT) {
    const fd = fs.openSync(target, 'r');
    try {
      const buf = Buffer.allocUnsafe(MAX_TEXT);
      fs.readSync(fd, buf, 0, MAX_TEXT, st.size - MAX_TEXT);
      return { ok: true, kind: 'text', path: target, bytes: st.size, line,
               truncated: true, text: buf.toString('utf8') };
    } finally { fs.closeSync(fd); }
  }
  return { ok: true, kind: 'text', path: target, bytes: st.size, line,
           text: fs.readFileSync(target, 'utf8') };
}

module.exports = { readFile, TEXT_EXT, IMAGE_EXT };
