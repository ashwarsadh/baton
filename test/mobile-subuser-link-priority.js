// mobile-subuser-link-priority.js — the owner opened a sub-user's link on their OWN phone, whose
// browser already carries the owner's `baton_m` cookie, and saw every session instead of the ones
// granted. Earlier tests used a bare bearer token with no cookie, which is why none caught it.
// This sends the request the way that phone did — the owner cookie AND a sub-user's `?k=` on the
// same request — and asserts the sub-user identity wins, because `?k=` is what was just opened.
// Ported from the private tool's test-subuser-link-priority.js; runs in a temp world.
'use strict';
const H = require('./mobile-harness');
const { check } = H;
const w = H.world('linkprio');

(async () => {
  const d = await H.boot(w);
  const all = (await d.req('/api/sessions?limit=300')).json.sessions || [];
  check(all.length > 1, 'precondition: more than one session on disk', all.length);
  const GRANTED = all[0] && all[0].id;
  const su = H.subuser(w, 'test-link-priority', [GRANTED]);
  const SUB = su.create().token;
  const k = encodeURIComponent(SUB);

  const r = await d.req(`/api/sessions?limit=300&k=${k}`, { cookie: d.token });
  const ids = (r.json.sessions || []).map(s => s.id);
  check(r.json.total === 1 && ids.length === 1 && ids[0] === GRANTED, 'an explicit ?k= wins over an owner cookie carried on the SAME request', `total=${r.json.total} ids=${ids.length}`);

  const r2 = await d.req(`/api/sessions?limit=300&k=${k}`, { token: null });
  const ids2 = (r2.json.sessions || []).map(s => s.id);
  check(ids2.length === 1 && ids2[0] === GRANTED, 'the same ?k= with no cookie also resolves to the sub-user');

  const r3 = await d.req('/api/sessions?limit=300', { cookie: d.token });
  check(r3.json.total > 1, 'the owner cookie ALONE (no ?k=) still resolves to full owner access', 'total=' + r3.json.total);

  const home = await d.req(`/?k=${k}`, { cookie: d.token });
  check(home.status === 302 && new RegExp('baton_m=' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(String(home.headers['set-cookie'] || '')),
        'opening the link replaces the owner cookie with the sub-user\'s', String(home.headers['set-cookie'] || '').slice(0, 30));

  const bad = await d.req('/api/sessions?k=not-a-real-key', { cookie: d.token });
  check(bad.status === 401, 'a WRONG ?k= is refused outright, never silently upgraded by the owner cookie', bad.status);

  su.revoke();
  check((await d.req(`/api/sessions?k=${k}`, { token: null })).status === 401, 'after revoke, the link no longer signs anyone in');
  su.remove();

  await d.stop();
  if (H.failures()) console.log(d.output().slice(-3000));
  H.finish(w);
})().catch(e => { console.error('THREW', e); process.exit(1); });
