// Google Drive settings page: show the fields for the chosen connection type, and follow the device sign-in.
(function () {
  var radios = document.querySelectorAll('[data-drive-mode]');
  function sync() {
    var m = (document.querySelector('[data-drive-mode]:checked') || {}).value || 'oauth';
    document.querySelectorAll('[data-mode]').forEach(function (el) { el.hidden = el.getAttribute('data-mode') !== m; });
  }
  radios.forEach(function (r) { r.addEventListener('change', sync); }); sync();

  var wait = document.querySelector('[data-device-wait]');
  if (wait) {
    var label = wait.querySelector('[data-dev-state]');
    var tick = function () {
      fetch('/settings/drive/status.json', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.dev.state === 'waiting') { setTimeout(tick, 2000); return; }
        location.href = '/settings/drive?' + (j.dev.state === 'done' ? 'msg=' + encodeURIComponent('Connected to Google Drive.') : 'err=' + encodeURIComponent(j.dev.state === 'denied' ? 'Access was denied on the Google page.' : j.dev.state === 'expired' ? 'The code expired. Click Connect again.' : 'Connecting failed. ' + (j.dev.error || '')));
      }).catch(function () { if (label) label.textContent = 'Lost contact with the server, retrying…'; setTimeout(tick, 4000); });
    };
    setTimeout(tick, 2000);
  }
  // while uploads are pending, refresh the counts
  var counts = document.querySelector('[data-drive-counts]');
  if (counts && /<b>[1-9]\d*<\/b> waiting/.test(counts.innerHTML)) setTimeout(function () { if (!document.querySelector('#drive-form :focus')) location.reload(); }, 5000);
})();
