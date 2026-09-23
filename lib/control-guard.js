// control-guard.js — keep the loopback control API (and its dashboard) for THIS computer's programs.
//
// Binding to 127.0.0.1 stops other machines, but not a web page open in your own browser: any site can
// make the browser send a POST to http://127.0.0.1:<port>/api/task, and a site that re-points its own
// hostname at 127.0.0.1 (DNS rebinding) can even read the answers. The CLI, the MCP tools and the
// tray never send an Origin header and always address the port by a loopback name, so:
//   - the Host header, when present, must be 127.0.0.1 / localhost / [::1] on this port;
//   - a state-changing request that carries an Origin (every browser request does) must come from
//     the dashboard itself, i.e. a loopback origin on this port. Sec-Fetch-Site: cross-site is refused.
'use strict';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

function allowedHost(value, port) {
  const v = String(value || '').trim().toLowerCase();
  return LOOPBACK.some(h => v === `${h}:${port}`);
}

/** Returns null when the request may proceed, or { status, body } to refuse it. */
function check(req, port) {
  const h = req.headers || {};
  if (h.host !== undefined && !allowedHost(h.host, port)) {
    return { status: 403, body: { ok: false, error: 'BAD_HOST', message: 'The control API answers only to 127.0.0.1 / localhost on its own port.' } };
  }
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (safe) return null;
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return { status: 403, body: { ok: false, error: 'CROSS_ORIGIN', message: 'Refused a request sent by another website.' } };
  }
  if (h.origin !== undefined) {
    let ok = false;
    try { const o = new URL(String(h.origin)); ok = o.protocol === 'http:' && allowedHost(o.host, port); } catch {}
    if (!ok) return { status: 403, body: { ok: false, error: 'CROSS_ORIGIN', message: 'Refused a request sent by another website (Origin ' + String(h.origin).slice(0, 80) + ').' } };
  }
  return null;
}

module.exports = { check, allowedHost };
