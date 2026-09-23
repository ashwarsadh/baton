(function () {
  'use strict';

  function fmtWhen(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso); if (!t) return '—';
    const d = new Date(t), diff = t - Date.now();
    const abs = d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (Math.abs(diff) < 60 * 1000) return 'now · ' + abs;
    const m = Math.round(Math.abs(diff) / 60000);
    const rel = m < 60 ? m + 'm' : m < 60 * 36 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
    return (diff > 0 ? 'in ' + rel : rel + ' ago') + ' · ' + abs;
  }

  async function openRoutines() {
    if (typeof drawer === 'function') drawer(false);
    showSheet($('view-routines'));
    $('routine-detail').hidden = true;
    $('routines').innerHTML = '<div class="empty">Loading…</div>';
    let d;
    try { d = await Promise.race([api('/api/routines'), new Promise((_, rj) => setTimeout(() => rj(new Error('timed out')), 20000))]); }
    catch (e) { $('routines').innerHTML = '<div class="empty">Could not load routines: ' + esc(e.message) + ' <button class="linkish" onclick="openRoutines()">retry</button></div>'; return; }
    state.routines = d.routines || [];
    $('routines-note').textContent = d.at
      ? 'Schedule state as of ' + fmtWhen(d.at) + ' · next runs computed from each cron'
      : 'No schedule snapshot yet — only what is on disk is shown';
    if (!state.routines.length) { $('routines').innerHTML = '<div class="empty">No routines on this machine.</div>'; return; }
    $('routines').innerHTML = state.routines.map(r => {
      const soon = r.nextRunAt && (Date.parse(r.nextRunAt) - Date.now()) < 6 * 3600 * 1000;
      const right = r.nextRunAt ? fmtWhen(r.nextRunAt)
        : r.enabled === false ? 'off' : r.kind === 'manual' ? 'manual' : '';
      const runs = r.runs.length + ' run' + (r.runs.length === 1 ? '' : 's');
      return '<div class="rt ' + (r.enabled === false ? 'off' : '') + '" data-id="' + esc(r.id) + '">'
        + '<div class="rt-name"><span>' + esc(r.name) + '</span>'
        + '<span class="rt-next ' + (soon ? 'soon' : '') + '">' + esc(right) + '</span></div>'
        + '<div class="rt-meta"><span>' + esc(r.schedule || 'no schedule') + '</span>'
        + '<span>last ' + esc(fmtWhen(r.lastRunAt)) + '</span><span>' + runs + '</span></div>'
        + (r.description ? '<div class="rt-desc">' + esc(r.description) + '</div>' : '')
        + '</div>';
    }).join('');
    $('routines').querySelectorAll('.rt').forEach(el => { el.onclick = () => openRoutine(el.dataset.id); });
  }

  async function openRoutine(id) {
    const r = (state.routines || []).find(x => x.id === id);
    if (!r) return;
    const box = $('routine-detail');
    box.hidden = false;
    const runs = r.runs.length
      ? r.runs.map(x => '<div class="rt-run" data-sid="' + esc(x.id) + '"><span>' + esc(fmtWhen(new Date(x.at).toISOString())) + '</span>'
          + '<span class="muted">' + (x.running ? 'running' : x.unread ? 'unread' : 'open ›') + '</span></div>').join('')
      : '<div class="muted">No runs recorded yet.</div>';
    box.innerHTML = '<h3 style="margin:8px 0 4px">' + esc(r.name) + '</h3>'
      + '<div class="rt-meta"><span>' + esc(r.schedule || 'no schedule') + '</span>'
      + (r.cronExpression ? '<span><code>' + esc(r.cronExpression) + '</code></span>' : '')
      + '<span>' + (r.enabled === false ? 'disabled' : 'enabled') + '</span></div>'
      + '<div class="rt-desc">' + esc(r.description || '') + '</div>'
      + '<div class="rt-meta" style="margin-top:8px"><span>next ' + esc(fmtWhen(r.nextRunAt)) + '</span><span>last ' + esc(fmtWhen(r.lastRunAt)) + '</span></div>'
      + '<h4 style="margin:12px 0 2px">Run history</h4><div class="rt-runs">' + runs + '</div>'
      + '<h4 style="margin:12px 0 4px">Prompt <button class="linkish" id="rt-load-prompt">show</button></h4>'
      + '<div id="rt-prompt" class="rt-prompt" hidden></div>';
    box.querySelectorAll('.rt-run').forEach(el => {
      el.onclick = () => { navOpenFrom(el.dataset.sid); hideSheet($('view-routines')); };
    });
    $('rt-load-prompt').onclick = async () => {
      const pb = $('rt-prompt'); pb.hidden = false; pb.textContent = 'Loading…';
      try { const d = await api('/api/routines/prompt?id=' + encodeURIComponent(id)); pb.textContent = d.prompt || '(empty)'; }
      catch (e) { pb.textContent = 'Failed: ' + e.message; }
    };
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('btn-routines').onclick = openRoutines;
  $('btn-close-routines').onclick = () => navBack();
  window.openRoutines = openRoutines;
})();
