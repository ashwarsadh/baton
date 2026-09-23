(function () {
  'use strict';

  const B = {
    data: null, bucket: 'all', days: 7, q: '',
    showHandled: false,
    busy: Object.create(null),
    posts: 0,
    drafts: Object.create(null),
    expanded: Object.create(null),
    answerFor: null,
    goalsOpen: false,
    goalsDoneOpen: false,
  };

  const EXP_KEY = 'baton-board-expanded';
  try {
    for (const id of JSON.parse(localStorage.getItem(EXP_KEY) || '[]')) B.expanded[id] = true;
  } catch {}
  function saveExpanded() {
    try { localStorage.setItem(EXP_KEY, JSON.stringify(Object.keys(B.expanded).slice(-120))); } catch {}
  }

  const BUCKETS = ['buried', 'decide', 'nudge', 'un', 'open'];

  const MY_BUNDLE = (function () {
    try {
      const tag = [...document.querySelectorAll('script[src*="board-ui.js"]')].pop();
      const m = tag && /[?&]v=([a-z0-9]+)/i.exec(tag.src);
      return m ? m[1] : 'unversioned';
    } catch { return 'unknown'; }
  })();

  function fmtAge(a) {
    if (a == null || a >= 999) return '';
    return a < 1 ? Math.round(a * 24) + 'h' : Math.round(a) + 'd';
  }

  function fmtWhen(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago';
  }

  function fmtBuilt(iso) {
    const t = Date.parse(iso); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? 'built ' + m + 'm ago' : 'built ' + Math.round(m / 60) + 'h ago';
  }

  async function openBoard() {
    if (typeof drawer === 'function') drawer(false);
    showSheet($('view-board'));
    if (!B.data) $('board-list').innerHTML = '<div class="empty">Loading…</div>';
    await loadBoard();
  }

  async function loadBoard() {
    B.busy = Object.create(null);
    let d;
    try { d = await api('/api/board'); }
    catch (e) {
      $('board-list').innerHTML = '<div class="empty">Could not load the board: ' + esc(e.message)
        + ' <button class="linkish" onclick="openBoard()">retry</button></div>';
      return;
    }
    B.data = d;
    render();
  }

  function staleBanner(serverBundle) {
    let el = $('board-stale');
    const stale = serverBundle && MY_BUNDLE !== 'unknown' && serverBundle !== MY_BUNDLE;
    if (!stale) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'board-stale';
      el.className = 'board-conductor bad';
      $('board-conductor').parentNode.insertBefore(el, $('board-conductor'));
    }
    el.innerHTML = '<b>This app is running an old version</b><span>buttons may do nothing — '
      + esc(MY_BUNDLE.slice(0, 6)) + ' vs ' + esc(String(serverBundle).slice(0, 6))
      + '</span><button class="bbtn b-yes" id="board-reload">Reload now</button>';
    $('board-reload').onclick = async () => {
      try { if (navigator.serviceWorker) {
        const rs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(rs.map(r => r.update()));
      } } catch {}
      location.replace(location.pathname + '?cb=' + Date.now() + location.hash);
    };
  }

  function conductorBanner() {
    const c = (B.data && B.data.conductor) || {};
    const el = $('board-conductor');
    el.className = 'board-conductor ' + (c.ok ? 'ok' : 'bad');
    el.innerHTML = c.ok
      ? '<b>Conductor ready</b><span>' + esc(c.reason || '') + '</span>'
      : '<b>Buttons will not send</b><span>' + esc(c.reason || 'The Conductor session is not available.') + '</span>';
  }

  function chips() {
    const d = B.data, counts = d.counts || {};
    const nInbox = (d.inbox || []).filter(r => r.status === 'open' && !r.acted && !r.handled).length;
    const mk = (wrap, label, n, key, on, cls) => {
      const b = document.createElement('button');
      b.className = 'chip' + (on ? ' on' : '') + (cls ? ' ' + cls : '');
      b.innerHTML = esc(label) + (n != null ? ' <span class="n">' + n + '</span>' : '');
      b.onclick = () => { B.bucket = key; render(); };
      wrap.appendChild(b);
    };
    const bw = $('board-buckets');
    bw.innerHTML = '';
    mk(bw, 'All', null, 'all', B.bucket === 'all');
    if (nInbox) mk(bw, 'For you', nInbox, 'inbox', B.bucket === 'inbox', 'b-inbox');
    const nGoals = ((d.goals || []).filter(g => g.status !== 'done')).length;
    if ((d.goals || []).length) {
      const gb = document.createElement('button');
      gb.className = 'chip' + (B.bucket === 'goals' ? ' on' : '');
      gb.innerHTML = 'Goals <span class="n">' + nGoals + '</span>';
      gb.onclick = () => { B.bucket = 'goals'; B.goalsOpen = true; B.showHandled = false; render(); };
      bw.appendChild(gb);
    }
    for (const k of ['decide', 'do', 'fyi']) {
      const n = (d.inbox || []).filter(r =>
        r.status === 'open' && !r.acted && !r.handled && r.ask_kind === k).length;
      if (!n) continue;
      mk(bw, KIND_LABEL[k], n, 'ask:' + k, B.bucket === 'ask:' + k, 'b-ask k-' + k);
    }
    for (const k of BUCKETS) {
      if (!counts[k] && !(d.rows || []).some(r => r.bucket === k)) continue;
      mk(bw, (d.labels && d.labels[k] ? d.labels[k].split('—')[0].trim() : k), counts[k] || 0, k, B.bucket === k, 'b-' + k);
    }
    const dw = $('board-days');
    dw.innerHTML = '';
    for (const n of [3, 7, 14, null]) {
      const b = document.createElement('button');
      b.className = 'chip' + (B.days === n && !B.showHandled ? ' on' : '');
      b.textContent = n === null ? 'All' : n + 'd';
      b.onclick = () => { B.days = n; B.showHandled = false; render(); };
      dw.appendChild(b);
    }
    const nDone = (d.rows || []).filter(r => r.acted || r.handled).length
      + (d.inbox || []).filter(r => r.status === 'open' && (r.acted || r.handled)).length;
    if (nDone) {
      const b = document.createElement('button');
      b.className = 'chip b-handled' + (B.showHandled ? ' on' : '');
      b.innerHTML = 'Handled <span class="n">' + nDone + '</span>';
      b.onclick = () => { B.showHandled = !B.showHandled; render(); };
      dw.appendChild(b);
    }
  }

  const matches = (hay) => !B.q || hay.toLowerCase().includes(B.q);

  function cardTitle(card) {
    const t = card.querySelector('.bcard-t');
    if (!t) return '';
    return [...t.childNodes].filter(n => !(n.nodeType === 1 && n.classList.contains('bgo')))
      .map(n => n.textContent).join('').trim().slice(0, 300);
  }

  function cardAsk(card) {
    const a = card && card.querySelector('.bcard-ask');
    if (!a) return '';
    return [...a.childNodes].filter(n => !(n.nodeType === 1 && n.tagName === 'B'))
      .map(n => n.textContent).join('').trim();
  }

  const KIND_LABEL = { decide: 'DECIDE', do: 'DO', fyi: 'FYI' };
  const KIND_HINT = { decide: 'needs your answer', do: 'needs your hands', fyi: 'read and clear' };

  function inboxCard(r) {
    const k = '#' + r.n, done = r.acted;
    const tap = r.openable && r.session;
    return '<div class="bcard inbox' + (done ? ' acted' : '') + '" data-id="' + esc(k) + '"'
      + (r.ts ? ' data-raised="' + esc(r.ts) + '"' : '') + '>'
      + '<div class="bcard-head head-x">'
      + '<div class="bcard-t bexp' + (B.expanded[k] ? ' open' : '') + '" role="button" tabindex="0"'
      + ' data-expand="' + esc(k) + '">'
      + '<div class="btext">' + (r.ask_kind
          ? '<span class="b-kind k-' + esc(r.ask_kind) + '">' + esc(KIND_LABEL[r.ask_kind] || '?') + '</span> '
          : '')
        + '#' + r.n + ' ' + esc(String(r.ask || r.text || '')) + '</div>'
      + '<span class="bgo"></span></div>'
      + '<div class="bcard-m"><span class="b-tag">' + esc(KIND_HINT[r.ask_kind] || 'For you') + '</span><span>' + esc((r.ts || '').slice(5, 16)) + '</span>'
      + (tap ? '<button class="bopen" data-open="' + esc(r.session) + '">Open session ›</button>' : '')
      + '</div></div>'
      + ((r.ask && r.text) ? '<div class="bcard-ask bnote' + (B.expanded[k] ? ' open' : '') + '" data-note="' + esc(k) + '">'
          + '<b>Why</b>' + esc(r.text) + '</div>' : '')
      + (r.note ? '<div class="bcard-ask bnote' + (B.expanded[k] ? ' open' : '') + '" data-note="' + esc(k) + '">'
          + '<b>Note</b>' + esc(r.note) + '</div>' : '')
      + actionsHtml(k, r.ask_kind === 'fyi' ? ['done'] : ['done', 'answer'], done, r.handled)
      + '</div>';
  }

  function sessionCard(r) {
    const done = r.acted;
    const sum = r.summary ? r.summary.filter(p => p[1]) : null;
    const overview = sum && sum.length
      ? '<div class="bcard-sum">' + sum.slice(0, 3).map(p =>
          '<div><b>' + esc(p[0]) + '</b>' + esc(String(p[1]).slice(0, 220)) + '</div>').join('') + '</div>'
      : '';
    return '<div class="bcard b-' + esc(r.bucket) + (done ? ' acted' : '') + '" data-id="' + esc(r.id) + '">'
      + (r.openable === false
          ? '<div class="bcard-head"><div class="bcard-t">' + esc(r.title) + '</div>'
          : '<div class="bcard-head tap" role="button" tabindex="0" data-open="' + esc(r.id) + '">'
            + '<div class="bcard-t linkish-t">' + esc(r.title) + '<span class="bgo">›</span></div>')
      + '<div class="bcard-m"><span class="b-tag b-' + esc(r.bucket) + '">'
        + esc((B.data.labels && B.data.labels[r.bucket] || r.bucket).split('—')[0].trim()) + '</span>'
      + '<span>' + esc(r.group || '') + '</span><span>' + esc(r.project || '') + '</span>'
      + '<span>' + fmtAge(r.age) + '</span>'
      + (r.critical ? '<span class="b-crit">⚠ outward / irreversible</span>' : '') + '</div></div>'
      + (r.ask ? '<div class="bcard-ask">' + esc(String(r.ask).slice(-500)) + '</div>' : '')
      + overview
      + actionsHtml(r.id, ['yes', 'answer', 'skip'], done, r.handled)
      + '</div>';
  }

  const LABELS = { yes: 'Yes', skip: 'Skip', answer: 'Answer…', done: 'Done ✓' };

  const SENT = { yes: 'Yes sent', skip: 'Skip sent', answer: 'Answer sent', done: 'Done sent' };

  function actionsHtml(id, kinds, done, handled) {
    if (handled) {
      return '<div class="bcard-done"><span class="bpill ok">Handled by the Conductor</span>'
        + '<span>' + esc(String(handled).slice(0, 80)) + '</span>'
        + '<button class="linkish" data-putback="' + esc(id) + '">put back</button></div>';
    }
    if (done) {
      return '<div class="bcard-done"><span class="bpill wait">' + esc(SENT[done.kind] || done.kind) + '</span>'
        + '<span>' + esc(fmtWhen(done.at)) + ' — waiting for the Conductor</span>'
        + '<button class="linkish" data-putback="' + esc(id) + '">put back</button></div>';
    }
    return '<div class="bcard-acts">' + kinds.map(k =>
      '<button class="bbtn b-' + k + '" data-act="' + k + '" data-target="' + esc(id) + '">' + LABELS[k] + '</button>').join('') + '</div>';
  }

  function goalsSection(d) {
    const goals = (d && d.goals) || [];
    if (!goals.length) return '';
    const now = Date.now();
    const dueMs = (g) => { const t = g.due ? Date.parse(g.due) : NaN; return isNaN(t) ? Infinity : t; };
    const overdue = (g) => dueMs(g) < now;
    const open = goals.filter(g => g.status !== 'done');
    const done = goals.filter(g => g.status === 'done');
    open.sort((a, b) => (overdue(b) - overdue(a)) || (dueMs(a) - dueMs(b)));

    const days = (g) => {
      if (!isFinite(dueMs(g))) return '';
      const diff = Math.round((dueMs(g) - now) / 86400000);
      if (diff < 0) return '<em class="gover">overdue ' + Math.abs(diff) + 'd</em>';
      return '<span class="gdue">due ' + (diff === 0 ? 'today' : 'in ' + diff + 'd') + '</span>';
    };

    const card = (g) => {
      const tap = g.session ? ' data-open="' + esc(g.session) + '" role="button" tabindex="0"' : '';
      const checks = (g.checks || []).length
        ? '<ul class="gchecks">' + g.checks.map(c => '<li>' + esc(String(c)) + '</li>').join('') + '</ul>'
        : '';
      return '<div class="gcard' + (overdue(g) ? ' gcard-over' : '') + '"' + tap + '>'
        + '<div class="gtitle">' + esc(g.title || g.id) + '</div>'
        + '<div class="gmeta">' + days(g)
        + (g.blocked_on ? ' <em class="gblocked">blocked: ' + esc(String(g.blocked_on)) + '</em>' : '')
        + (g.session ? ' <span class="gsess">' + esc(String(g.session).slice(0, 14)) + '…</span>' : '')
        + '</div>'
        + checks
        + '</div>';
    };

    const nOver = open.filter(overdue).length;
    return '<details class="goals"' + (B.goalsOpen ? ' open' : '') + ' id="goals-reg">'
      + '<summary><b>Projects &amp; where they have got to</b> <span class="n">' + open.length + ' open</span>'
      + (nOver ? ' <em class="gover">' + nOver + ' overdue</em>' : '')
      + '<p>Nothing here needs you — this is where the work has got to.</p></summary>'
      + open.map(card).join('')
      + (done.length
          ? '<details class="goals-done"' + (B.goalsDoneOpen ? ' open' : '') + ' id="goals-done">'
            + '<summary>Finished <span class="n">' + done.length + '</span></summary>'
            + done.map(card).join('') + '</details>'
          : '')
      + '</details>';
  }

  function render() {
    const d = B.data;
    if (!d) return;
    $('board-built').textContent = fmtBuilt(d.built_at) + ' · v' + MY_BUNDLE.slice(0, 6);
    staleBanner(d.bundle);
    conductorBanner();
    chips();

    const isDone = (r) => !!(r.acted || r.handled);
    const askKind = B.bucket.startsWith('ask:') ? B.bucket.slice(4) : null;
    const showInbox = B.bucket === 'all' || B.bucket === 'inbox' || !!askKind;
    const inbox = showInbox
      ? (d.inbox || []).filter(r => r.status === 'open' && isDone(r) === B.showHandled
          && (!askKind || r.ask_kind === askKind)
          && matches('#' + r.n + ' ' + (r.ask || '') + ' ' + r.text + ' ' + (r.note || '')))
      : [];
    const rows = (B.bucket === 'inbox' || askKind) ? [] : (d.rows || []).filter(r =>
      (B.bucket === 'all' || r.bucket === B.bucket)
      && isDone(r) === B.showHandled && (r.age == null || B.days === null || r.age <= B.days)
      && matches([r.title, r.group, r.project, r.ask, r.state].join(' ')));

    const html = [];
    if (inbox.length) {
      html.push('<div class="bsec"><h3>For you <span>' + inbox.length + '</span></h3>'
        + '<p>Only you can do these — nothing else on this page needs you.</p></div>');
      html.push(inbox.map(inboxCard).join(''));
    }
    for (const k of BUCKETS) {
      const rs = rows.filter(r => r.bucket === k);
      if (!rs.length) continue;
      const lbl = (d.labels && d.labels[k]) || k;
      html.push('<div class="bsec"><h3>' + esc(lbl) + ' <span>' + rs.length + '</span></h3>'
        + '<p>' + esc((d.hints && d.hints[k]) || '') + '</p></div>');
      html.push(rs.map(sessionCard).join(''));
    }
    const reg = ((B.bucket === 'all' || B.bucket === 'goals') && !B.showHandled) ? goalsSection(d) : '';
    $('board-list').innerHTML = (html.length ? html.join('')
      : reg ? ''
      : '<div class="empty">' + (B.showHandled ? 'Nothing handled in the last 12 hours.'
                                               : 'Nothing waiting for this filter.') + '</div>') + reg;
    markClamped();
  }

  function markClamped() {
    const list = $('board-list');
    if (!list.clientHeight) { requestAnimationFrame(markClamped); return; }
    for (const t of list.querySelectorAll('.bcard-t.bexp')) {
      const body = t.querySelector('.btext');
      if (!body) continue;
      const wasOpen = t.classList.contains('open');
      if (wasOpen) t.classList.remove('open');
      t.classList.toggle('clamped', body.scrollHeight - body.clientHeight > 2);
      if (wasOpen) t.classList.add('open');
    }
  }

  async function send(kind, id, text) {
    if (B.busy[id] && Date.now() - B.busy[id] < 30000) { toast('That one is still sending…'); return; }
    B.busy[id] = Date.now();
    const card = $('board-list').querySelector('.bcard[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (card) card.classList.add('sending');
    try {
      B.posts++;
      const r = await api('/api/board/act', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, id: id, text: text || '' }),
      });
      toast(r.delivered ? 'Sent — card cleared' : 'Queued for the Conductor — card cleared');
      await loadBoard();
    } catch (e) {
      toast('Not sent: ' + e.message, true);
      if (/conductor-unavailable|send-failed/.test(e.message)) loadBoard();
    } finally {
      delete B.busy[id];
      if (card) card.classList.remove('sending');
    }
  }

  $('board-list').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      const id = open.dataset.open;
      const card = open.closest('.bcard');
      const ask = (card && (card.querySelector('.bcard-ask:not(.bnote)') || {}).textContent) || '';
      const raised = card && card.dataset.raised;
      navOpenFrom(id).then(() => { if (!scrollToAsk(ask) && raised) scrollToRaiseTime(raised); });
      hideSheet($('view-board'));
      return;
    }
    const noteHit = e.target.closest('[data-note]');
    const exp = noteHit
      ? (noteHit.closest('.bcard') || document).querySelector('[data-expand]')
      : e.target.closest('[data-expand]');
    if (exp) {
      const id = exp.dataset.expand;
      const open = exp.classList.toggle('open');
      const card = exp.closest('.bcard');
      const note = card && card.querySelector('.bnote');
      if (note) note.classList.toggle('open', open);
      if (open) B.expanded[id] = true; else delete B.expanded[id];
      saveExpanded();
      return;
    }
    const head = e.target.closest('.bcard-head');
    if (head && !head.classList.contains('tap')
        && !(head.closest('.bcard') || head).querySelector('[data-open]')) {
      toast('No session is linked to this item yet, so there is nothing to open — the buttons below still work');
      return;
    }
    const back = e.target.closest('[data-putback]');
    if (back) {
      const id = back.dataset.putback;
      api('/api/board/unhide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
        .then(() => { toast('Put back on the board — the line already went, this only un-hides it'); loadBoard(); })
        .catch(err => toast('Could not put it back: ' + err.message, true));
      return;
    }
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.target, kind = b.dataset.act;
    if (kind !== 'answer') {
      const before = B.posts;
      setTimeout(() => {
        if (B.posts === before) toast('That tap did nothing — reload the app (pull down) and try again', true);
      }, 1000);
    }
    if (kind === 'answer') {
      const card = b.closest('.bcard');
      openAnswer(id, cardTitle(card), cardAsk(card));
      return;
    }
    send(kind, id);
  });

  function landOn(msg) {
    const go = () => msg.scrollIntoView({ block: 'center' });
    go(); setTimeout(go, 350); setTimeout(go, 1200);
    msg.classList.add('askhit');
    setTimeout(() => msg.classList.remove('askhit'), 2600);
  }

  function landWhenPainted(find, missMsg, settleMs) {
    const hardDeadline = Date.now() + 15000;
    let softDeadline = null;
    const tick = () => {
      const msgs = [...document.querySelectorAll('#log .msg')];
      if (msgs.length) {
        const hit = find(msgs);
        if (hit) { landOn(hit); return; }
        if (settleMs != null && softDeadline == null) softDeadline = Date.now() + settleMs;
      }
      const done = Date.now() >= hardDeadline || (softDeadline != null && Date.now() >= softDeadline);
      if (!done) { setTimeout(tick, 250); return; }
      if (missMsg) toast(missMsg);
    };
    setTimeout(tick, 250);
  }

  function scrollToAsk(ask) {
    const norm = (x) => String(x || '').replace(/[*_`~#>\[\]()]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const needle = norm(ask).slice(0, 40);
    if (needle.length < 12) return false;
    landWhenPainted(
      (msgs) => msgs.reverse().find(m => norm(m.textContent).includes(needle)),
      'Opened at the latest message — could not find the exact one.');
    return true;
  }

  const RAISE_WINDOW_MS = 45 * 60 * 1000;

  function scrollToRaiseTime(iso) {
    const raised = Date.parse(iso);
    if (!raised) return false;
    landWhenPainted((msgs) => {
      let best = null, bestGap = Infinity;
      for (const m of msgs) {
        const st = m.nextElementSibling;
        if (!st || !st.classList.contains('stamp')) continue;
        const t = Date.parse(st.dataset.ts || '');
        if (!t || t > raised) continue;
        const gap = raised - t;
        if (gap < bestGap) { bestGap = gap; best = m; }
      }
      return bestGap <= RAISE_WINDOW_MS ? best : null;
    }, 'Opened at the latest message — nothing in this session lines up with when this was raised.',
       1500);
    return true;
  }

  const DRAFT_KEY = (id) => 'baton-board-draft-' + id;

  function saveDraft(id, text) {
    B.drafts[id] = text;
    try { text ? localStorage.setItem(DRAFT_KEY(id), text) : localStorage.removeItem(DRAFT_KEY(id)); } catch {}
  }
  function loadDraft(id) {
    if (B.drafts[id] != null) return B.drafts[id];
    try { return localStorage.getItem(DRAFT_KEY(id)) || ''; } catch { return ''; }
  }

  function growAnswer() {
    const t = $('answer-text');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, Math.round(window.innerHeight * 0.38)) + 'px';
  }

  function openAnswer(id, title, ask) {
    B.answerFor = id;
    $('answer-for').textContent = title;
    const askBox = $('answer-ask');
    askBox.textContent = ask || '';
    askBox.hidden = !ask;
    const t = $('answer-text');
    t.value = loadDraft(id);
    $('answer-note').textContent = t.value ? 'Draft restored.' : '';
    showSheet($('answersheet'));
    growAnswer();
    t.focus();
    try { t.setSelectionRange(t.value.length, t.value.length); } catch {}
  }

  function closeAnswer() {
    if (B.answerFor) saveDraft(B.answerFor, $('answer-text').value);
    B.answerFor = null;
    hideSheet($('answersheet'));
  }

  async function sendAnswer() {
    const id = B.answerFor, text = $('answer-text').value;
    if (!id) return;
    if (!text.trim()) { $('answer-note').textContent = 'Nothing to send yet.'; $('answer-text').focus(); return; }
    $('answer-send').disabled = true;
    $('answer-note').textContent = 'Sending…';
    const before = B.posts;
    await send('answer', id, text);
    $('answer-send').disabled = false;
    if (B.posts > before && !B.busy[id]) {
      saveDraft(id, '');
      B.answerFor = null;
      hideSheet($('answersheet'));
    } else {
      $('answer-note').textContent = 'Not sent — your text is still here. Try again.';
    }
  }

  $('answer-text').addEventListener('input', () => {
    growAnswer();
    if (B.answerFor) saveDraft(B.answerFor, $('answer-text').value);
  });
  $('answer-send').onclick = sendAnswer;
  $('answer-cancel').onclick = closeAnswer;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('answersheet').classList.contains('hidden')) {
      e.stopPropagation(); closeAnswer();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('view-board').classList.contains('hidden')) {
      e.stopPropagation(); hideSheet($('view-board'));
    }
  }, true);

  $('board-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest('[data-open], [data-expand]');
    if (t) { e.preventDefault(); t.click(); }
  });

  $('board-list').addEventListener('toggle', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'DETAILS') return;
    if (t.id === 'goals-reg') B.goalsOpen = t.open;
    if (t.id === 'goals-done') B.goalsDoneOpen = t.open;
  }, true);

  $('board-q').oninput = (e) => { B.q = e.target.value.trim().toLowerCase(); render(); };
  $('btn-board').onclick = openBoard;
  const openIfHashed = () => {
    const m = /^#board(?:=([a-z]+))?$/.exec(location.hash);
    if (!m) return;
    if (m[1]) B.bucket = m[1];
    openBoard();
  };
  if (document.readyState === 'complete') openIfHashed();
  else window.addEventListener('load', openIfHashed);
  window.addEventListener('hashchange', openIfHashed);
  $('btn-board-refresh').onclick = () => { $('board-list').innerHTML = '<div class="empty">Loading…</div>'; loadBoard(); };
  $('btn-close-board').onclick = () => navBack();
  window.openBoard = openBoard;
})();
