(function () {
  'use strict';

  var PANEL_ID = 'accounts-panel';
  var state = null;
  var busy = false;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function short(scope) { return scope ? scope.slice(0, 8) + '…' : ''; }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) { return r.json(); });
  }

  function load() {
    return api('/api/accounts').then(function (d) { state = d; render(); return d; });
  }

  function migrate(from, to) {
    if (busy) return;
    busy = true;
    render();
    api('/api/accounts/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from, to: to })
    }).then(function (r) {
      busy = false;
      if (!r.ok) {
        alert('Could not prepare the move:\n\n' + (r.error || '') + '\n' + (r.detail || ''));
      }
      return load();
    }).catch(function (e) {
      busy = false;
      alert('Request failed: ' + e.message);
      render();
    });
  }

  function render() {
    var host = document.getElementById(PANEL_ID);
    if (!host) return;
    host.innerHTML = '';
    if (!state) { host.appendChild(el('div', 'muted', 'Loading accounts…')); return; }
    if (!state.ok) { host.appendChild(el('div', 'muted', 'Accounts unavailable: ' + (state.error || ''))); return; }

    var scopes = (state.scopes || []).filter(function (s) { return s.records > 0; });
    var activeScope = state.active && state.active.scope;

    scopes.forEach(function (s) {
      var card = el('div', 'acct-card' + (s.active ? ' acct-active' : ''));

      var head = el('div', 'acct-head');
      head.appendChild(el('strong', null, s.label || short(s.account)));
      if (s.active) head.appendChild(el('span', 'acct-badge', 'signed in'));
      card.appendChild(head);

      var stats = el('div', 'acct-stats');
      stats.appendChild(el('span', null, s.records + ' sessions'));
      if (s.archived != null) stats.appendChild(el('span', null, s.archived + ' archived'));
      stats.appendChild(el('span', null, s.groups + ' groups'));
      stats.appendChild(el('span', null, s.assignments + ' assigned'));
      card.appendChild(stats);

      if (!s.active && activeScope) {
        var btn = el('button', 'acct-btn', busy ? 'Preparing…' : 'Move everything here');
        btn.disabled = busy;
        btn.addEventListener('click', function () {
          var msg = 'Copy all sessions and sidebar groups from\n' +
            (state.active.email || short(activeScope)) + '\nto\n' + (s.label || short(s.account)) + '?\n\n' +
            'Your current account is not changed and keeps everything.\n' +
            'Groups are written the moment you quit Claude Desktop.';
          if (confirm(msg)) migrate(activeScope, s.scope);
        });
        card.appendChild(btn);
      }
      host.appendChild(card);
    });

    var g = state.groupGuard || {};
    var foot = el('div', 'acct-foot');

    var drift = (g.status && g.status.lines || []).filter(function (l) { return /DRIFT/.test(l); });
    if (g.taskRegistered === false) {
      foot.appendChild(el('div', 'acct-armed', '⚠ Group guard is NOT registered — sidebar groups are unprotected.'));
    } else if (drift.length) {
      foot.appendChild(el('div', 'acct-armed', '⚠ Group drift detected — it is repaired when you next quit Desktop:'));
      drift.forEach(function (l) { foot.appendChild(el('pre', 'acct-log', l)); });
    } else if (g.status && g.status.lines && g.status.lines.length) {
      foot.appendChild(el('div', 'acct-ok', '✓ Sidebar groups protected — ' +
        g.status.lines.filter(function (l) { return /OK/.test(l); }).length + ' account(s) checked, no drift.'));
    }

    var saved = (g.savedLogins || []).filter(function (p) { return p.complete; });
    foot.appendChild(el('div', 'muted', saved.length
      ? 'Saved logins: ' + saved.map(function (p) { return p.email || p.account.slice(0, 8); }).join(', ') +
        ' — switching to these needs no sign-in.'
      : 'No login saved yet. The first time you quit Desktop, the account you were using is captured.'));

    var m = state.migration || {};
    if (m.done) {
      foot.appendChild(el('div', 'acct-ok', '✓ Groups applied. Sign in on the other account to see everything.'));
    } else if (m.armed) {
      foot.appendChild(el('div', 'acct-armed',
        '⏳ Armed. Quit Claude Desktop and the sidebar groups are written automatically.'));
    }
    if (m.log && m.log.length) {
      var pre = el('pre', 'acct-log', m.log.join('\n'));
      foot.appendChild(pre);
    }
    if (state.note) foot.appendChild(el('div', 'muted', state.note));
    host.appendChild(foot);
  }

  window.AccountsUI = {
    mount: function (container) {
      if (!container) return;
      if (!document.getElementById(PANEL_ID)) {
        var wrap = el('section', 'acct-wrap');
        wrap.appendChild(el('h3', 'acct-title', 'Accounts'));
        var host = el('div');
        host.id = PANEL_ID;
        wrap.appendChild(host);
        container.appendChild(wrap);
      }
      render();
      load();
    },
    refresh: load
  };

  document.addEventListener('DOMContentLoaded', function () {
    var slot = document.getElementById('accounts-slot');
    if (slot) window.AccountsUI.mount(slot);
  });
})();
