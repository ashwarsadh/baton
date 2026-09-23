// settings-ui.js — Settings, phone pairing and first-run welcome. Same screen on phone and desktop.
(function () {
  'use strict';

  var MODULES = [
    ['app', 'Phone & desktop app', 'Sessions, chat, send, model and effort, notifications. Turning this off also turns off this screen after a restart.'],
    ['autoResume', 'Auto-resume', 'Continue sessions that stopped on a usage limit (when it resets) or because Claude Desktop crashed.'],
    ['orchestrator', 'Orchestrator', 'Master/worker tools for Claude (baton_* MCP tools): spawn workers, track a fleet, goals, waiting for results.'],
    ['masterNotify', 'Wake the master', 'When a worker finishes or asks something, tell the session that is coordinating it.'],
    ['chipAutostart', 'Auto-start task chips', 'Press Start on background-task suggestions in sessions a master owns, only while you are away from the keyboard.'],
    ['routines', 'Routines', 'Show Claude Code scheduled tasks in the app.'],
    ['board', 'Board', 'A tappable to-do board read from board.json (for a Conductor session). See docs/BOARD.md.'],
    ['accounts', 'Accounts (experimental)', 'See the Claude accounts signed in on this computer.'],
  ];
  var REMOTE = [
    ['off', 'This computer only', 'The app answers on 127.0.0.1. Nothing is exposed.'],
    ['tailscale', 'Tailscale', 'Reachable from your devices on your tailnet. Install Tailscale on both.'],
    ['lan', 'Same Wi-Fi', 'Reachable from devices on your local network (plain HTTP, no push notifications).'],
    ['cloudflare-quick', 'Anywhere — quick link', 'A free random https://….trycloudflare.com address. No account. Changes when Baton restarts.'],
    ['cloudflare-named', 'Anywhere — my own address', 'A fixed https address on your domain through your free Cloudflare account. Best for daily use.'],
  ];

  var S = null, section = 'general', pairData = null, saving = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function req(path, body) {
    var o = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) { o.method = 'POST'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json(); });
  }
  function note(msg, err) { if (typeof window.toast === 'function') window.toast(msg, err); }

  function ensureDom() {
    if ($('view-settings')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<section id="view-settings" class="sheet hidden settings" role="dialog" aria-modal="true" aria-label="Settings">' +
      '<div class="sheet-body">' +
      '<div class="grab"></div>' +
      '<h2 id="set-title">Settings</h2>' +
      '<nav class="chips" id="set-tabs" aria-label="Settings sections"></nav>' +
      '<div id="set-body" class="set-body"></div>' +
      '<div class="sheet-actions"><button id="btn-close-settings" class="ghost">Done</button></div>' +
      '</div></section>');
    $('btn-close-settings').onclick = close;
    $('view-settings').addEventListener('click', function (e) { if (e.target.id === 'view-settings') close(); });
    var head = document.querySelector('.drawer-head');
    if (head && !$('btn-settings')) {
      var b = document.createElement('button');
      b.id = 'btn-settings'; b.className = 'icon-btn'; b.title = 'Settings'; b.setAttribute('aria-label', 'Settings');
      b.textContent = '⚙';
      b.onclick = function () { open('general'); };
      var closeBtn = $('btn-close-drawer');
      head.insertBefore(b, closeBtn || null);
    }
  }

  function tabs() {
    var list = [['general', 'Modules'], ['remote', 'Remote access'], ['pair', 'Pair a phone'], ['notify', 'Notifications'], ['advanced', 'Advanced'], ['about', 'About']];
    $('set-tabs').innerHTML = list.map(function (t) {
      return '<button class="chip' + (t[0] === section ? ' on' : '') + '" data-sec="' + t[0] + '">' + t[1] + '</button>';
    }).join('');
    Array.prototype.forEach.call($('set-tabs').querySelectorAll('button'), function (b) {
      b.onclick = function () { section = b.dataset.sec; render(); };
    });
  }

  function toggle(key, label, desc, on) {
    return '<label class="set-row"><span class="set-text"><b>' + esc(label) + '</b><small>' + esc(desc) + '</small></span>' +
      '<input type="checkbox" class="set-switch" data-key="' + key + '"' + (on ? ' checked' : '') + '></label>';
  }
  function field(key, label, value, hint, type) {
    return '<label class="set-field"><span><b>' + esc(label) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</span>' +
      '<input data-field="' + key + '" type="' + (type || 'text') + '" value="' + esc(value) + '" autocomplete="off"></label>';
  }

  function save(patch, quiet) {
    if (saving) return Promise.resolve();
    saving = true;
    return req('/api/settings', patch).then(function (r) {
      saving = false;
      if (r && r.ok) { S = r.settings; applyVisibility(); if (!quiet) note('Saved'); render(); }
      else note('Could not save: ' + ((r && r.error) || 'unknown error'), true);
    }).catch(function (e) { saving = false; note('Could not save: ' + e.message, true); });
  }
  function setPath(obj, dotted, val) {
    var parts = dotted.split('.'), o = obj;
    for (var i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = val;
    return obj;
  }
  function getPath(obj, dotted) { return dotted.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj); }

  function renderGeneral() {
    var m = S.modules || {};
    return '<p class="set-lead">Turn features on or off. Changes apply within a minute; the app module needs a restart.</p>' +
      MODULES.map(function (x) { return toggle('modules.' + x[0], x[1], x[2], !!m[x[0]]); }).join('') +
      '<h3>While you work</h3>' +
      field('idleGateSeconds', 'Idle gate (seconds)', S.idleGateSeconds, 'Baton drives the Claude Desktop window. It waits until you have not touched keyboard or mouse for this long. 0 = never wait.', 'number');
  }

  function renderRemote() {
    var r = S.remote || {};
    var t = (pairData && pairData.tunnel) || {};
    var h = '<p class="set-lead">How your phone reaches this computer. The app always needs your access key (it is inside the pairing QR code), so an address alone lets nobody in.</p>';
    h += REMOTE.map(function (x) {
      return '<label class="set-radio"><input type="radio" name="remote" value="' + x[0] + '"' + (r.mode === x[0] ? ' checked' : '') + '>' +
        '<span><b>' + esc(x[1]) + '</b><small>' + esc(x[2]) + '</small></span></label>';
    }).join('');
    if (r.mode === 'cloudflare-quick' || r.mode === 'cloudflare-named') {
      h += '<div class="set-card">';
      if (!t.cloudflared) {
        h += '<b>Install cloudflared first</b><p>Windows: <code>winget install Cloudflare.cloudflared</code><br>macOS: <code>brew install cloudflared</code><br>Then press Check again.</p><button class="ghost" id="set-recheck">Check again</button>';
      } else if (r.mode === 'cloudflare-quick') {
        h += '<b>Status: ' + esc(t.status || 'stopped') + '</b>' + (t.url ? '<p>' + esc(t.url) + '</p>' : '') + (t.error ? '<p class="set-err">' + esc(t.error) + '</p>' : '') +
          '<p>Open <b>Pair a phone</b> to scan the link.</p>';
      } else {
        h += '<b>Step 1 — connect your Cloudflare account</b>';
        h += t.loggedIn ? '<p>✔ This computer is authorised.</p>'
          : '<p>You need a free Cloudflare account with a domain on it.</p><button class="ghost primary" id="set-cf-login">Log in to Cloudflare</button>';
        h += '<b>Step 2 — choose your address</b>' +
          '<div class="set-inline"><input id="set-cf-host" placeholder="baton.example.com" value="' + esc(r.hostname || '') + '"><button class="ghost primary" id="set-cf-setup"' + (t.loggedIn ? '' : ' disabled') + '>Create</button></div>';
        if (r.hostname) h += '<p>Status: <b>' + esc(t.status || 'stopped') + '</b>' + (t.error ? ' — <span class="set-err">' + esc(t.error) + '</span>' : '') + '</p>';
        h += '<details><summary>Optional: Cloudflare Access (email login)</summary><p>Protect the address with Cloudflare Zero Trust Access. Enter your team name and the application AUD tag; Baton then accepts verified Access logins without the key.</p>' +
          field('remote.access.team', 'Team domain', (r.access || {}).team || '', 'e.g. myteam.cloudflareaccess.com') +
          field('remote.access.aud', 'Application AUD tag', (r.access || {}).aud || '', '') + '</details>';
      }
      h += '</div>';
    }
    if (r.mode === 'tailscale') h += '<div class="set-card"><p>Install Tailscale on this computer and your phone, sign both into the same account, then use <b>Pair a phone</b>.</p></div>';
    return h;
  }

  function renderPair() {
    if (!pairData) { loadPair(); return '<div class="empty">Loading…</div>'; }
    var links = pairData.links || [];
    var best = links[0];
    var h = '<p class="set-lead">Scan with your phone’s camera. The link signs the phone in and remembers it. Then use your browser’s <b>Add to Home screen</b> to install Baton like an app.</p>';
    if (best && best.kind === 'local') h += '<div class="set-card set-warn">This computer is not reachable from your phone yet. Choose an option in <a href="#" id="go-remote">Remote access</a> first.</div>';
    h += links.map(function (l, i) {
      return '<div class="set-qr' + (i ? ' small' : '') + '"><div class="qr">' + (l.qr || '') + '</div><div><b>' + esc(l.label) + '</b><code class="set-url">' + esc(l.url) + '</code>' +
        '<button class="ghost set-copy" data-url="' + esc(l.url) + '">Copy link</button></div></div>';
    }).join('');
    h += '<p class="set-small">The link contains your access key — treat it like a password. <a href="#" id="set-rotate">Issue a new key</a> to sign out every phone.</p>';
    return h;
  }

  function renderNotify() {
    var n = S.notifications || {};
    return '<p class="set-lead">Push notifications need HTTPS (Cloudflare) or this computer. Tap 🔔 in the session list on each phone to subscribe.</p>' +
      toggle('notifications.enabled', 'Notifications', 'Master switch.', n.enabled !== false) +
      toggle('notifications.awaiting', 'Needs your input', 'A session is waiting for an answer or a permission.', n.awaiting !== false) +
      toggle('notifications.done', 'Finished', 'A session finished its turn.', n.done !== false) +
      field('notifications.pushSubject', 'Contact for push services', n.pushSubject || '', 'A mailto: or https: address; browsers’ push services may use it to contact you.');
  }

  function renderAdvanced() {
    var w = S.workers || {};
    return '<p class="set-lead">Ports apply after restarting Baton.</p>' +
      field('appPort', 'App port', S.appPort, 'The phone/desktop app.', 'number') +
      field('port', 'Control port', S.port, 'Local API used by the CLI and MCP tools (loopback only).', 'number') +
      field('cdpPort', 'Claude Desktop debugger port', S.cdpPort, 'Developer › Enable Main Process Debugger in Claude Desktop.', 'number') +
      toggle('autoEnableDebugger', 'Re-enable the debugger automatically', 'Windows: after Claude Desktop restarts, switch the debugger back on while you are away from the keyboard.', S.autoEnableDebugger !== false) +
      '<h3>Workers</h3>' +
      field('workers.defaultModel', 'Default model', w.defaultModel || '', 'Workers start on this model; effort is chosen per task.') +
      field('workers.concurrency', 'Headless workers at once', w.concurrency, '', 'number') +
      field('workers.guiConcurrency', 'Desktop workers at once', w.guiConcurrency, '', 'number') +
      '<h3>Conductor</h3>' +
      field('conductorSession', 'Conductor session id', S.conductorSession || '', 'Optional. The session that receives Board taps and master reports (local_…).') +
      field('board.dir', 'Board folder', (S.board || {}).dir || '', 'Folder containing board.json. Blank = the default in Baton’s data folder.') +
      field('ownerIndex', 'Owner index folder', S.ownerIndex || '', 'Optional folder describing which session owns which topic.');
  }

  function renderAbout(extra) {
    return '<div class="set-about"><img src="/icon.svg" width="64" height="64" alt=""><div><b>Baton</b> ' + esc(S.__version || '') +
      '<p>Your Claude Code sessions, in your pocket.</p></div></div>' +
      '<p class="set-small">Data folder: <code>' + esc(S.__dataDir || '') + '</code></p>' +
      '<p class="set-small">Baton is an independent open-source project and is not affiliated with Anthropic. It drives the Claude Desktop app you are already signed in to; it never sees your password.</p>' +
      '<p><button class="ghost" id="set-welcome">Show the welcome tour</button></p>';
  }

  function renderWelcome() {
    return '<div class="set-about"><img src="/icon.svg" width="64" height="64" alt=""><div><b>Welcome to Baton</b><p>Your Claude Code sessions, in your pocket.</p></div></div>' +
      '<ol class="set-steps">' +
      '<li><b>Your sessions, anywhere.</b> Every Claude Code session from the desktop app, live: read, reply, answer questions and permissions, switch model and effort, start new sessions.</li>' +
      '<li><b>Nothing stalls.</b> Sessions stopped by a usage limit continue when it resets; sessions cut off by a crash pick up again.</li>' +
      '<li><b>A conductor for many sessions.</b> Tell one session “you are the master” and it can spawn workers, track them and get woken when they finish.</li>' +
      '<li><b>Everything is optional.</b> Switch modules on and off in Settings.</li></ol>' +
      '<div class="sheet-actions"><button class="ghost primary" id="set-start">Pair my phone</button><button class="ghost" id="set-skip">Later</button></div>';
  }

  function render() {
    if (!S) return;
    tabs();
    var body = $('set-body');
    $('set-title').textContent = section === 'welcome' ? 'Welcome' : 'Settings';
    $('set-tabs').style.display = section === 'welcome' ? 'none' : '';
    body.innerHTML = section === 'general' ? renderGeneral()
      : section === 'remote' ? renderRemote()
      : section === 'pair' ? renderPair()
      : section === 'notify' ? renderNotify()
      : section === 'advanced' ? renderAdvanced()
      : section === 'welcome' ? renderWelcome()
      : renderAbout();
    wire(body);
  }

  function wire(body) {
    Array.prototype.forEach.call(body.querySelectorAll('.set-switch'), function (c) {
      c.onchange = function () { save(setPath({}, c.dataset.key, c.checked)); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-field]'), function (inp) {
      inp.onchange = function () {
        var v = inp.type === 'number' ? Number(inp.value) : inp.value.trim();
        save(setPath({}, inp.dataset.field, v));
      };
    });
    Array.prototype.forEach.call(body.querySelectorAll('input[name=remote]'), function (r) {
      r.onchange = function () { pairData = null; save({ remote: { mode: r.value } }).then(loadPair); };
    });
    Array.prototype.forEach.call(body.querySelectorAll('.set-copy'), function (b) {
      b.onclick = function () {
        try { navigator.clipboard.writeText(b.dataset.url); note('Link copied'); } catch (e) { note('Copy failed', true); }
      };
    });
    var x;
    if ((x = $('go-remote'))) x.onclick = function (e) { e.preventDefault(); section = 'remote'; render(); };
    if ((x = $('set-recheck'))) x.onclick = function () { loadPair(); };
    if ((x = $('set-cf-login'))) x.onclick = function () {
      x.disabled = true; x.textContent = 'Opening…';
      req('/api/tunnel/login', {}).then(function (r) {
        if (r.loginUrl) { window.open(r.loginUrl, '_blank'); note('Finish the login in the new tab, then come back'); pollLogin(); }
        else if (r.already) { note('Already connected'); loadPair(); }
        else note(r.error || 'Login did not start', true);
      });
    };
    if ((x = $('set-cf-setup'))) x.onclick = function () {
      var host = $('set-cf-host').value.trim();
      x.disabled = true; x.textContent = 'Creating…';
      req('/api/tunnel/setup', { hostname: host }).then(function (r) {
        if (r.ok) { note('Address ready: https://' + r.hostname); pairData = null; load(); }
        else { note(r.error || 'Setup failed', true); x.disabled = false; x.textContent = 'Create'; }
      });
    };
    if ((x = $('set-rotate'))) x.onclick = function (e) {
      e.preventDefault();
      if (!confirm('Issue a new access key? Every paired phone and browser will need to scan again after Baton restarts.')) return;
      req('/api/token/rotate', {}).then(function (r) { note(r.note || 'Done'); });
    };
    if ((x = $('set-welcome'))) x.onclick = function () { section = 'welcome'; render(); };
    if ((x = $('set-start'))) x.onclick = function () { save({ onboarded: true }, true); section = 'pair'; render(); };
    if ((x = $('set-skip'))) x.onclick = function () { save({ onboarded: true }, true); close(); };
  }

  function pollLogin() {
    var n = 0;
    var t = setInterval(function () {
      req('/api/tunnel').then(function (r) {
        if ((r.tunnel && r.tunnel.loggedIn) || ++n > 60) { clearInterval(t); loadPair(); }
      });
    }, 3000);
  }

  function loadPair() {
    return req('/api/pair').then(function (r) { pairData = r; if (section === 'pair' || section === 'remote') render(); });
  }

  function load() {
    return req('/api/settings').then(function (r) {
      if (!r || !r.ok) return;
      S = r.settings; S.__version = r.version; S.__dataDir = r.dataDir;
      applyVisibility();
      render();
      return S;
    });
  }

  function applyVisibility() {
    var m = (S && S.modules) || {};
    var map = { 'btn-board': 'board', 'btn-routines': 'routines', 'btn-accounts': 'accounts' };
    Object.keys(map).forEach(function (id) { var b = $(id); if (b) b.style.display = m[map[id]] ? '' : 'none'; });
  }

  function open(sec) {
    ensureDom();
    section = sec || 'general';
    if (section === 'pair') loadPair();
    if (section === 'remote') loadPair();
    var sheet = $('view-settings');
    if (typeof window.showSheet === 'function') window.showSheet(sheet); else sheet.classList.remove('hidden');
    load();
  }
  function close() {
    var sheet = $('view-settings');
    if (typeof window.hideSheet === 'function') window.hideSheet(sheet); else sheet.classList.add('hidden');
    if (/^#(settings|pair)$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }

  window.batonSettings = { open: open, close: close };

  function boot() {
    ensureDom();
    load().then(function (s) {
      if (!s) return; // a scoped sub-user: settings are owner-only
      if (location.hash === '#pair') open('pair');
      else if (location.hash === '#settings') open('general');
      else if (!s.onboarded) open('welcome');
    });
    window.addEventListener('hashchange', function () {
      if (location.hash === '#pair') open('pair');
      else if (location.hash === '#settings') open('general');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
