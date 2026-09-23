// make-demo.js <dir> — write a fake Claude Desktop data set (sessions + transcripts) for demos,
// screenshots and UI work without touching real data. Run Baton against it with:
//   APPDATA=<dir>/appdata CLAUDE_CONFIG_DIR=<dir>/claude BATON_HOME=<dir>/baton node server.js
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = path.resolve(process.argv[2] || 'demo');
const store = path.join(dir, 'appdata', 'Claude', 'claude-code-sessions', '00000000-demo-acct', '00000000-demo-org');
const projects = path.join(dir, 'claude', 'projects');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(projects, { recursive: true });

const now = Date.now();
const root = process.platform === 'win32' ? 'C:\\Users\\you\\projects\\' : '/home/you/projects/';
const S = [
  ['Refactor auth middleware to async/await', 'web-app', 'claude-opus-5-5', 'medium', 2, true],
  ['Fix flaky checkout e2e test', 'web-app', 'claude-opus-5-5', 'high', 9],
  ['Write API reference for v2 endpoints', 'docs', 'claude-opus-5-5', 'low', 35],
  ['Migrate database to Postgres 17', 'backend', 'claude-opus-5-5', 'high', 70],
  ['Landing page redesign — hero + pricing', 'marketing-site', 'claude-sonnet-5', 'medium', 180],
  ['Nightly dependency audit', 'backend', 'claude-opus-5-5', 'low', 600],
  ['Add dark mode to the mobile app', 'mobile-app', 'claude-opus-5-5', 'medium', 1400],
];
const ev = (type, content, ts) => JSON.stringify({ type, timestamp: new Date(ts).toISOString(), uuid: crypto.randomUUID(),
  message: type === 'user' ? { role: 'user', content } : { role: 'assistant', content } });

S.forEach(([title, proj, model, effort, minsAgo, rich], i) => {
  const id = 'local_' + crypto.randomUUID();
  const cli = crypto.randomUUID();
  const cwd = root + proj;
  const t = now - minsAgo * 60000;
  fs.writeFileSync(path.join(store, id + '.json'), JSON.stringify({
    sessionId: id, cliSessionId: cli, title, cwd, model, effort, isArchived: false,
    permissionMode: 'acceptEdits', createdAt: t - 3600000, lastActivityAt: t, completedTurns: 3 + i,
  }, null, 2));
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  fs.mkdirSync(path.join(projects, slug), { recursive: true });
  const lines = [
    ev('user', title + '. Keep the public API unchanged and add tests.', t - 600000),
    ev('assistant', [{ type: 'text', text: 'On it. I will map the current call sites first, then change the implementation behind the same interface.' }], t - 590000),
  ];
  if (rich) {
    lines.push(ev('assistant', [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'function authenticate', path: 'src' } }], t - 580000));
    lines.push(ev('user', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'src/middleware/auth.js:12\nsrc/routes/admin.js:40' }], t - 575000));
    lines.push(ev('assistant', [{ type: 'text', text: 'Two call sites. I converted `authenticate()` to `async` and replaced the callback chain:\n\n```js\nexport async function authenticate(req) {\n  const token = await readToken(req);\n  return verify(token);\n}\n```\n\nAll **42 tests pass**. Shall I also update the admin routes to use the new helper?' }], t - 120000));
  }
  fs.writeFileSync(path.join(projects, slug, cli + '.jsonl'), lines.join('\n') + '\n');
});
console.log('demo data written to ' + dir);
