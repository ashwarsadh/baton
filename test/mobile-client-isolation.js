// mobile-client-isolation.js — the outcome of an action must reach the client that asked for it,
// and nobody else. Ported from the private tool's test-client-isolation.js (which ran against the
// live daemon). Three listeners — two identified clients and one anonymous (an app on an old cached
// build) — and three requests; asserts who received which `uiresult`. Offline: the action is a
// fast-mode change, which with no desktop reachable fails at once, but still produces exactly one
// result that has to be routed.
'use strict';
const H = require('./mobile-harness');
const { check, wait } = H;
const w = H.world('isolation');

(async () => {
  const d = await H.boot(w);
  const A = d.stream('test-client-A');
  const B = d.stream('test-client-B');
  const OLD = d.stream(null);
  await wait(1200);
  check(A.status === 200 && B.status === 200 && OLD.status === 200, 'three listeners connected');
  const id = (w.sessions()[0] || {}).sessionId;
  const fast = async (client) => (await d.req('/api/fast', { method: 'POST', body: { id, fast: false },
    headers: client ? { 'X-Baton-Client': client } : {} })).json.jobId;
  const results = (l) => l.filter(e => e.event === 'uiresult' && e.data.op === 'fast').map(e => e.data.jobId);

  const jA = await fast('test-client-A');
  check(!!jA, 'the request is accepted with a job id', jA);
  await d.waitFor(A, e => e.event === 'uiresult' && e.data.jobId === jA, 10000);
  await wait(800);
  check(results(A).includes(jA), 'A received its own result');
  check(!results(B).includes(jA), 'B did NOT receive A\'s result', results(B));
  check(!results(OLD).includes(jA), 'the old anonymous client did NOT receive A\'s result');

  const jB = await fast('test-client-B');
  await d.waitFor(B, e => e.event === 'uiresult' && e.data.jobId === jB, 10000);
  await wait(800);
  check(results(B).includes(jB), 'B received its own result');
  check(!results(A).includes(jB), 'A did NOT receive B\'s result');

  // A request from a tool with no client id.
  const jX = await fast(null);
  await d.waitFor(OLD, e => e.event === 'uiresult' && e.data.jobId === jX, 10000);
  await wait(800);
  check(!results(A).includes(jX), 'an anonymous request did NOT reach identified client A');
  check(!results(B).includes(jX), 'an anonymous request did NOT reach identified client B');
  check(results(OLD).includes(jX), 'an anonymous request still reaches an old anonymous client (compatibility)');

  await d.stop();
  if (H.failures()) console.log(d.output().slice(-3000));
  H.finish(w);
})().catch(e => { console.error('THREW', e); process.exit(1); });
