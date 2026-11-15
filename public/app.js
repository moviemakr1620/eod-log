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
