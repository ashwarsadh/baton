// first-screen.js — what a cold open lands on (mobile/public/app.js firstScreen). The function is taken
// from app.js as written and run against stubs: the Board when something waits for you, else the last
// session you were in, else the most recently active one; never over something you opened meanwhile;
// a slow or disabled Board never holds the first screen back.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const check = (ok, name, extra) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined && !ok ? '  ' + JSON.stringify(extra).slice(0, 300) : ''}`); if (!ok) failed++; };

const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
const board = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'board-ui.js'), 'utf8');
const src = app.slice(app.indexOf('const FIRST_SCREEN_WAIT_MS'), app.indexOf('async function openChat(id) {'));

function run({ waiting = 0, waitFn = null, last = null, sessions = [], openMeanwhile = false, waitMs = 50 } = {}) {
  const did = [];
  const store = { 'baton.lastChat': last };
  const drawerEl = { classList: { contains: () => false } };
  const ctx = {
    state: { open: null, rawSessions: sessions },
    window: {
      boardWaiting: waitFn || (async () => { if (openMeanwhile) ctx.state.open = 'tapped'; return waiting; }),
      openBoard: () => did.push('board'),
    },
    localStorage: { getItem: k => store[k] || null },
    visibleSheetId: () => null,
    $: () => drawerEl,
    openChat: id => did.push('chat:' + id),
    drawer: () => did.push('drawer'),
    setTimeout, Promise,
  };
  vm.createContext(ctx);
  vm.runInContext(src.replace(/FIRST_SCREEN_WAIT_MS = \d+/, 'FIRST_SCREEN_WAIT_MS = ' + waitMs) + '\nthis.firstScreen = firstScreen;', ctx);
  return ctx.firstScreen().then(r => ({ r, did }));
}

(async () => {
  check(src.length > 300 && /async function firstScreen\(\)/.test(src), 'firstScreen is found in app.js');
  const S = [{ id: 'old', at: 1 }, { id: 'newest', at: 9 }, { id: 'arch', at: 99, archived: true }, { id: 'mine', at: 5 }];

  let x = await run({ waiting: 2, last: 'mine', sessions: S });
  check(x.r === 'board' && x.did.join() === 'board', 'something waits on the Board: the Board opens', x);
  x = await run({ waiting: 0, last: 'mine', sessions: S });
  check(x.r === 'session' && x.did.join() === 'chat:mine', 'nothing waiting: the session you were last in', x);
  x = await run({ waiting: 0, last: 'gone', sessions: S });
  check(x.did.join() === 'chat:newest', 'last session gone: the most recently active one (archived ones skipped)', x);
  x = await run({ waiting: 0, last: 'arch', sessions: S });
  check(x.did.join() === 'chat:newest', 'an archived last session is not reopened', x);
  x = await run({ waiting: 0, sessions: [] });
  check(x.r === 'drawer' && x.did.join() === 'drawer', 'no sessions at all: the session list', x);
  x = await run({ waiting: 3, sessions: S, openMeanwhile: true });
  check(x.r === 'user' && x.did.length === 0, 'something you opened while it loaded wins: nothing is opened over it', x);
  x = await run({ waitFn: async () => { throw new Error('module disabled'); }, last: 'mine', sessions: S });
  check(x.did.join() === 'chat:mine', 'a disabled or failing Board counts as nothing waiting', x);
  const t0 = Date.now();
  x = await run({ waitFn: () => new Promise(() => {}), last: 'mine', sessions: S, waitMs: 80 });
  check(x.did.join() === 'chat:mine' && Date.now() - t0 < 1000, 'a Board that never answers is given up on after FIRST_SCREEN_WAIT_MS', { ms: Date.now() - t0, x });

  // Wiring: boot asks firstScreen only without a ?s= link and with no sheet open; the chat remembers itself.
  check(/\} else if \(!visibleSheetId\(\)\) \{\s*window\.__batonFirstScreen = await firstScreen\(\);/.test(app), 'boot uses firstScreen only when no ?s= link and no sheet is open');
  check(!/openChat\(state\.sessions\[0\]\.id\)/.test(app), 'the old desktop-only "first session in the list" rule is gone');
  check(/state\.open = id;\s*try \{ localStorage\.setItem\('baton\.lastChat', id\); \} catch \{\}/.test(app), 'opening a session remembers it as the last one');
  check(/window\.boardWaiting = async \(\) => \{[\s\S]*?Filter\.count\(d\.inbox, filt\(\{ bucket: 'inbox', showHandled: false \}\)\)/.test(board), 'the Board counts exactly its "For you" items');

  console.log(failed ? `\n${failed} check(s) failed` : '\nall first-screen checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
