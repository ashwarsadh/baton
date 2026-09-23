'use strict';
const fs = require('fs');
const path = require('path');
const desktop = require('../lib/desktop');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MAX_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json',
};

const pasteJs = (b64, name, type) => `(async function(){
  var el = document.querySelector('[data-testid="code-prompt-input"]') ||
           document.querySelector('.tiptap.ProseMirror');
  if(!el) return 'no-editor';
  el.focus();

  var bin = atob(${JSON.stringify(b64)});
  var buf = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  var file = new File([buf], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });

  var dt = new DataTransfer();
  dt.items.add(file);
  var ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
  el.dispatchEvent(ev);
  await new Promise(function(r){ setTimeout(r, 1200); });
  return 'pasted';
})()`;

const VERIFY_JS = `(function(){
  function clean(e){ return (e&&e.textContent||'').replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'').trim(); }
  var form = document.querySelector('[data-testid="code-prompt-input"]');
  var box = form;
  for (var i=0;i<8 && box;i++){ box = box.parentElement; if(!box) break;
    var imgs = box.querySelectorAll('img,[data-testid*="attach" i],[aria-label*="attach" i],[aria-label*="Remove" i]');
    if (imgs.length) return JSON.stringify({ found: imgs.length,
      labels: Array.from(imgs).slice(0,5).map(function(e){ return e.getAttribute('aria-label')||e.tagName; }) });
  }
  return JSON.stringify({ found: 0 });
})()`;

async function pasteFiles(sessionId, files = []) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) return { ok: true, pasted: [] };
  if (!(await desktop.cdpAvailable())) return { ok: false, error: 'CDP_UNAVAILABLE' };

  const conn = await desktop.connect(await desktop.wsUrl());
  let CID;
  try {
    CID = await desktop.pickChat(conn);
    const here = String(await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`)));
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

    const pasted = [];
    for (const f of list) {
      let buf;
      try { buf = fs.readFileSync(f); } catch (e) { return { ok: false, error: 'UNREADABLE', file: f, message: e.message }; }
      if (buf.length > MAX_BYTES) return { ok: false, error: 'TOO_LARGE', file: f, bytes: buf.length };
      const ext = path.extname(f).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const r = await conn.evaluate(desktop.rEval(CID, pasteJs(buf.toString('base64'), path.basename(f), type)));
      if (r !== 'pasted') return { ok: false, error: 'PASTE_FAILED', file: f, detail: r };
      pasted.push({ file: f, bytes: buf.length, type });
      await sleep(600);
    }

    let attachments = null;
    try { attachments = JSON.parse(await conn.evaluate(desktop.rEval(CID, VERIFY_JS)) || '{}'); } catch {}
    return { ok: true, pasted, attachments };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally { conn.close(); }
}

module.exports = { pasteFiles, MAX_BYTES };
