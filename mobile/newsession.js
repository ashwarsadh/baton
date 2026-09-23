'use strict';
const desktop = require('../lib/desktop');
const gui = require('../lib/gui-worker');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CLICK_NEW_JS = gui.CLICK_NEW_JS;

const sendJs = (html, dryRun) => `(async function(){
  if(location.href.split('/').pop() !== 'epitaxy') return 'nav-lost';
  var el = document.querySelector('.tiptap.ProseMirror');
  if(!el || !el.editor) return 'no-editor';
  el.editor.commands.focus();
  el.editor.commands.setContent('${html}');
  var b=null;
  for (var i=0;i<15;i++){
    await new Promise(function(r){setTimeout(r,100);});
    b=document.querySelector('button[aria-label="Send"]');
    if(b && !b.disabled) break;
  }
  var typed=(el.textContent||'').trim().length;
  if(location.href.split('/').pop() !== 'epitaxy'){
    try{ el.editor.commands.clearContent(); }catch(e){}
    return 'nav-lost';
  }
  if(${dryRun ? 'true' : 'false'}){
    var ready=!!(b && !b.disabled);
    el.editor.commands.clearContent();
    return 'dry:'+(ready?'ready':'not-ready')+':'+typed;
  }
  if(b && !b.disabled){ b.click(); return 'sent-tentative:'+typed; }
  el.editor.commands.clearContent();
  return 'blocked';
})()`;

async function newSession(opts = {}) {
  const { cwd, prompt, model, effort, group, dryRun } = opts;
  if (!cwd) return { ok: false, error: 'NO_CWD', message: 'Pick a folder.' };
  if (!String(prompt || '').trim() && !dryRun) return { ok: false, error: 'EMPTY_PROMPT', message: 'Type something to start with.' };
  if (String(prompt || '').length > gui.MAX_PROMPT_CHARS) {
    return { ok: false, error: 'PROMPT_TOO_LONG',
             message: `${prompt.length} characters exceeds the ${gui.MAX_PROMPT_CHARS} the composer is trusted with.` };
  }
  if (!(await desktop.cdpAvailable())) {
    return { ok: false, error: 'CDP_UNAVAILABLE', message: "Claude Desktop's debugger is not reachable on 127.0.0.1:9229." };
  }

  let step = 'connect';
  const at = async (name, fn) => { step = name; const t = Date.now();
    try { return await fn(); } finally { timings.push(`${name} ${Date.now() - t}ms`); } };
  const timings = [];

  const conn = await desktop.connect(await desktop.wsUrl());
  let original = null;
  const restore = async () => { if (original) { try { await desktop.restoreActive(conn, CID, original); } catch {} } };
  let CID;
  try {
    CID = await at('pick-window', () => desktop.pickChat(conn));
    const before = JSON.parse(await at('read-current-view', () =>
      conn.evaluate(desktop.rEval(CID, `JSON.stringify({active:location.href.split('/').pop()})`))));
    original = before.active && String(before.active).startsWith('local_') ? before.active : null;

    const clicked = await at('click-new', () => conn.evaluate(desktop.rEval(CID, CLICK_NEW_JS)));
    if (clicked !== 'clicked') { await restore(); return { ok: false, error: 'NO_NEW_BUTTON', message: 'The sidebar New button was not found.' }; }
    await sleep(2600);

    const onNew = await at('confirm-new-view', () => conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`)));
    if (onNew !== 'epitaxy') {
      await restore();
      return { ok: false, error: 'NEW_VIEW_NOT_REACHED', message: `Expected the new-session view, got "${onNew}".` };
    }

    const folder = await at('pick-folder', () => gui.selectFolder(conn, CID, gui.folderLabelFor(cwd)));
    if (!folder.ok) {
      await restore();
      return { ok: false, error: folder.error, message: folder.message || 'Folder could not be selected.',
               offered: folder.offered || [] };
    }

    let modelRes = null, effortRes = null;
    if (model) {
      modelRes = await at('pick-model', () => gui.selectModel(conn, CID, model));
      if (!modelRes.ok) { await restore(); return { ok: false, error: modelRes.error, message: JSON.stringify(modelRes), offered: modelRes.offered || [] }; }
    }
    if (effort) effortRes = await at('pick-effort', () => gui.selectEffort(conn, CID, effort));

    const perm = await at('permission-mode', () => gui.ensureBypassPermissions(conn, CID));
    if (!perm.ok) {
      await restore();
      return { ok: false, error: perm.error,
               message: 'Permission mode could not be set to bypass; a session left prompting would stall on a yellow dot.' };
    }

    const res = await at('send-prompt', () =>
      conn.evaluate(desktop.rEval(CID, sendJs(desktop.composerHtml(String(prompt || 'test')), !!dryRun))));

    if (dryRun) {
      await restore();
      const [, verdict, typed] = String(res || '').split(':');
      return { ok: String(res || '').startsWith('dry:ready'), dryRun: true, result: res,
               charsTyped: Number(typed) || 0, folder: folder.folder, model: modelRes, effort: effortRes,
               note: 'Composer was filled on the new-session view and cleared. No session was created.' };
    }

    if (!String(res || '').startsWith('sent-tentative')) {
      await restore();
      return { ok: false, error: 'SEND_' + String(res || 'blocked').toUpperCase().replace(/[^A-Z_]/g, '_'),
               message: `The prompt could not be sent on the new-session view (${res}).` };
    }

    let sid = '';
    for (let i = 0; i < 40 && !sid; i++) {
      await sleep(400);
      const here = await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`));
      if (here && String(here).startsWith('local_')) sid = String(here);
    }
    if (!sid) {
      await restore();
      return { ok: false, error: 'NO_SESSION_ID',
               message: 'The prompt was sent but the URL never became a session id, so the new session could not be identified.' };
    }

    if (effort && !(effortRes && effortRes.ok)) {
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) {
        await sleep(300);
        ready = (await conn.evaluate(desktop.rEval(CID, `
          (function(){
            var b=Array.from(document.querySelectorAll('button')).find(function(e){
              return e.offsetParent!==null && /^effort/i.test((e.textContent||'').trim()); });
            return b ? 'yes' : 'no';
          })()`))) === 'yes';
      }
      if (!ready) {
        effortRes = { ok: false, error: 'GUI_NO_EFFORT_CONTROL',
                      message: 'The composer never showed an effort control for the new session.' };
      } else {
        try { effortRes = await at('set-effort-after-create', () => gui.selectEffort(conn, CID, effort)); }
        catch (e) { effortRes = { ok: false, error: 'EXCEPTION', message: e.message }; }
      }
    }

    const restored = original;
    await restore();
    original = null;

    let grouped = null;
    if (group) {
      try { grouped = await desktop.setGroup(sid, group, { noEscape: true }); }
      catch (e) { grouped = { ok: false, error: e.message }; }
    }

    return { ok: true, sessionId: sid, folder: folder.folder, model: modelRes, effort: effortRes,
             group: grouped, restored };
  } catch (e) {
    try { await restore(); } catch {}
    const inner = step === 'pick-folder' && gui.lastFolderSteps ? gui.lastFolderSteps() : [];
    return { ok: false, error: 'EXCEPTION', step,
             message: `${e.message} at step "${step}" (${timings.join(', ') || 'no step completed'})`
                      + (inner.length ? ` [folder: ${inner.join(', ')}]` : '') };
  } finally { conn.close(); }
}

module.exports = { newSession };
