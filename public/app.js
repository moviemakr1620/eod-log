// Small helpers used on every page (no inline scripts: CSP is script-src 'self').
document.addEventListener('change', function (ev) {
  var el = ev.target;
  if (el.matches && el.matches('[data-goto-week]') && el.value) location.href = '/?week=' + el.value;
});
document.addEventListener('submit', function (ev) {
  var f = ev.target, msg = f.getAttribute && f.getAttribute('data-confirm');
  if (msg && !confirm(msg)) ev.preventDefault();
});
if (/[?&]saved=1/.test(location.search)) {
  try { localStorage.removeItem('eod-draft-new'); } catch (e) { /* private mode */ }
  history.replaceState(null, '', location.pathname);
}
// notification form: show only the fields that apply to the chosen frequency
(function () {
  var f = document.querySelector('[data-freq]');
  if (!f) return;
  function sync() { document.querySelectorAll('[data-show]').forEach(function (el) { el.hidden = el.getAttribute('data-show').split(' ').indexOf(f.value) < 0; }); }
  f.addEventListener('change', sync); sync();
})();
// any form: never submit a half-typed native date/time (the browser reports it as empty)
document.addEventListener('submit', function (ev) {
  var bad = Array.prototype.filter.call(ev.target.querySelectorAll('input'), function (i) { return i.validity && i.validity.badInput; });
  if (bad.length) { ev.preventDefault(); ev.stopImmediatePropagation(); bad.forEach(function (i) { i.classList.add('bad'); }); alert('A date or time is only partly filled in. Finish it or clear it.'); bad[0].focus(); }
}, true);
