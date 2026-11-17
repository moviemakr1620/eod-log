// Runs in <head> before first paint (a normal blocking script, because the CSP is script-src 'self': no inline scripts).
// Theme = the person's saved choice on this device, else the system setting (prefers-color-scheme).
(function () {
  var KEY = 'eod-theme', root = document.documentElement, mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var BAR = { light: '#111827', dark: '#0d1320' }; // header colours, so the phone's status bar matches
  function saved() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : ''; } catch (e) { return ''; } }
  function apply(t) {
    root.setAttribute('data-theme', t); root.style.colorScheme = t;
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', BAR[t]);
  }
  window.eodTheme = {
    current: function () { return root.getAttribute('data-theme') || 'light'; },
    toggle: function () { var n = this.current() === 'dark' ? 'light' : 'dark'; try { localStorage.setItem(KEY, n); } catch (e) { /* private mode: still switches for this page */ } apply(n); return n; },
    reapply: function () { apply(saved() || (mq && mq.matches ? 'dark' : 'light')); },
  };
  window.eodTheme.reapply();
  // follow the system when nothing is saved; keep tabs on the same device in step
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!saved()) window.eodTheme.reapply(); });
  window.addEventListener('storage', function (e) { if (e.key === KEY) window.eodTheme.reapply(); });
})();
