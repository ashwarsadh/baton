// display-ui.js — text size and density, per device (the Display sheet, "Aa" in the drawer).
//
// HOW THE ZOOM WORKS, and why it is not a font-size. Every size in style.css is in px, so a root
// font-size would change nothing. CSS `zoom` on <html> reflows the whole layout exactly as browser
// zoom does. Under zoom z, px AND vh/vw lengths render at z times their size, while innerHeight and
// visualViewport stay unzoomed. Two things compensate: --app-h is set from JS as height / z
// (syncViewport in app.js), and every vh/vw in style.css is written calc(N vh / var(--z,1)). Fixed
// inset:0 layers already fill the viewport. A new vh rule that forgets the divide leaves a gap at the
// bottom when zoomed out; test/display.js fails on it.
//
// Density: html[data-density=compact] (the default) tightens rows, chips, headers and cards, never
// touch targets on a touch screen. "Comfortable" is the earlier look, unchanged. The first-paint copy
// of both lives in an inline script in index.html's head; this file owns changing them.
(function () {
  const ZMIN = 0.7, ZMAX = 1.5, STEP = 0.05;
  const root = document.documentElement;
  const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const clampZ = z => Math.min(ZMAX, Math.max(ZMIN, Math.round(z / STEP) * STEP));

  function zoom() { const z = parseFloat(get('baton.zoom', '1')); return isFinite(z) ? clampZ(z) : 1; }
  function applyZoom() {
    const z = zoom();
    root.style.setProperty('--z', String(z));
    root.style.zoom = z === 1 ? '' : String(z);
    if (typeof syncViewport === 'function') syncViewport();
    const v = document.getElementById('zoom-val'); if (v) v.textContent = Math.round(z * 100) + '%';
    const r = document.getElementById('zoom-range'); if (r) r.value = String(Math.round(z * 100));
  }
  function density() { return get('baton.density', 'compact') === 'comfortable' ? 'comfortable' : 'compact'; }
  function applyDensity() {
    root.setAttribute('data-density', density());
    document.querySelectorAll('#density-seg button').forEach(b => b.classList.toggle('on', b.dataset.d === density()));
  }
  function setZoom(z) { put('baton.zoom', String(clampZ(z))); applyZoom(); }

  const $ = id => document.getElementById(id);
  $('btn-display').onclick = () => { applyZoom(); applyDensity(); showSheet($('view-display')); };
  $('btn-close-display').onclick = () => navBack();
  $('zoom-minus').onclick = () => setZoom(zoom() - STEP);
  $('zoom-plus').onclick = () => setZoom(zoom() + STEP);
  $('zoom-range').oninput = e => setZoom(Number(e.target.value) / 100);
  $('zoom-reset').onclick = () => { put('baton.zoom', '1'); put('baton.density', 'compact'); applyZoom(); applyDensity(); };
  document.querySelectorAll('#density-seg button').forEach(b => {
    b.onclick = () => { put('baton.density', b.dataset.d); applyDensity(); };
  });
  applyZoom(); applyDensity();
})();
