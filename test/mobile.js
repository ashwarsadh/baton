// mobile.js — run every test/mobile-*.js suite (offline; each builds its own temp world) and exit
// non-zero if any fails. mobile-harness.js is the shared helper, not a suite.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const only = process.argv.slice(2);
const suites = fs.readdirSync(__dirname)
  .filter(f => /^mobile-.+\.js$/.test(f) && f !== 'mobile-harness.js')
  .filter(f => !only.length || only.some(o => f.includes(o)))
  .sort();
const failed = [];
for (const f of suites) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  const n = (out.match(/^ok {3}/gm) || []).length;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}  (${n} checks, ${((Date.now() - t) / 1000).toFixed(1)}s)`);
  if (!ok) { failed.push(f); console.log(out.split('\n').filter(l => /^FAIL|THREW|Error/.test(l)).slice(0, 20).join('\n') || out.slice(-2000)); }
}
console.log(failed.length ? `\n${failed.length} mobile suite(s) failed: ${failed.join(', ')}` : `\nall ${suites.length} mobile suites passed`);
process.exit(failed.length ? 1 : 0);
