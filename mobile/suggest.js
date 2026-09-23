'use strict';
const desktop = require('../lib/desktop');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GENERIC = /^type \/ for commands$/i;

const READ_JS = `(function(){
  function clean(e){ return (e&&e.textContent||'').trim(); }
  var el = document.querySelector('[data-testid="code-prompt-input"]') ||
           document.querySelector('.tiptap.ProseMirror');
  if(!el) return '\u0000NO_COMPOSER';
  var er = el.getBoundingClientRect();
  if (er.width > 0 && er.height > 0) {
    var top = el.parentElement;
    for (var u = 0; u < 5 && top && top.parentElement; u++) top = top.parentElement;
    var geo = Array.from(top.querySelectorAll('span,div,p')).filter(function(n){
      if (n.childElementCount || n === el || el.contains(n)) return false;
      if (!clean(n)) return false;
      var r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      var ox = Math.min(r.right, er.right) - Math.max(r.left, er.left);
      var oy = Math.min(r.bottom, er.bottom) - Math.max(r.top, er.top);
      return ox > 8 && oy > 4 && r.top >= er.top - 4;
    })[0];
    if (geo) return clean(geo);
  }
  var box = el.parentElement;
  for (var k = 0; k < 5 && box; k++) {
    var hit = Array.from(box.querySelectorAll('span,div')).filter(function(n){
      if (n.childElementCount) return false;
      if (n === el || el.contains(n)) return false;          // never the typed draft itself
      var own = String(n.className || '');
      var over = false;
      for (var a = n, j = 0; a && a !== box.parentElement && j < 4; a = a.parentElement, j++) {
        var c = String(a.className || '');
        if (c.indexOf('absolute') >= 0 && (c.indexOf('pointer-events-none') >= 0 || c.indexOf('inset-0') >= 0 || c.indexOf('overflow-hidden') >= 0)) { over = true; break; }
      }
      if (!over) return false;
      return clean(n).length > 0;
    })[0];
    if (hit) return clean(hit);
    box = box.parentElement;
  }
  if (clean(el)) return '';
  var p = el.querySelector('p[data-placeholder]');
  if (p) return p.getAttribute('data-placeholder') || '';
  return '\u0000NO_OVERLAY';
})()`;

async function readSuggestion(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  if (!(await desktop.cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE' };
  const conn = await desktop.connect(await desktop.wsUrl());
  let CID, original = null;
  try {
    CID = await desktop.pickChat(conn);
    const here = String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`)));
    original = here.startsWith('local_') ? here : null;
    if (here !== sessionId) {
      const found = await desktop.findSessionRow(conn, CID, sessionId);
      if (!found.row) return { ok: false, error: 'NO_SUCH_SESSION' };
      await conn.evaluate(desktop.rEval(CID, `
        (function(){
          var b=document.querySelector('[data-row-key="code:${sessionId}"] [data-row-main-button]');
          if(!b) return 'not-found';
          b.scrollIntoView({block:'center',behavior:'instant'}); b.click(); return 'ok';
        })()`));
      await sleep(2600);
    }
    const raw = String(await conn.evaluate(desktop.rEval(CID, READ_JS)) || '').trim();
    if (raw.charCodeAt(0) === 0) return { ok: false, error: raw.slice(1) };
    const suggestion = raw && !GENERIC.test(raw) ? raw : null;
    return { ok: true, suggestion };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally {
    try { if (original) await desktop.restoreActive(conn, CID, original); } catch {}
    conn.close();
  }
}

module.exports = { readSuggestion };
