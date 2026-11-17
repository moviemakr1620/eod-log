/* Shared hours maths (browser + Node).
 * TOTAL hours = Stop - Start - meal breaks. Stop earlier than Start = past midnight.
 * ON-SET hours = On set start -> On set end, minus any part of a meal break that falls inside that window.
 * They are two separate figures; neither changes the other. Old leave/return-shop times are kept but never used. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EODHours = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /** Normalise anything a browser or a person might send into "HH:MM" (24h), or null.
   * Accepts "7:30", "07:30", "07:30:00", "07:30:00.000", "7:30 PM", "7:30pm", "730", "1930", "7pm". */
  function norm(t) {
    if (t === null || t === undefined) return null;
    var s = String(t).trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    var m = /^(\d{1,2})(?::?(\d{2}))?(?::\d{2}(?:\.\d+)?)?(am|pm|a|p)?$/.exec(s);
    if (!m) return null;
    var h = +m[1], mi = m[2] ? +m[2] : 0, ap = m[3];
    if (ap) { if (h < 1 || h > 12) return null; if (ap[0] === 'p' && h < 12) h += 12; if (ap[0] === 'a' && h === 12) h = 0; }
    if (h > 23 || mi > 59) return null;
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }
  // "730"/"1930" style (no colon, 3-4 digits)
  function norm2(t) {
    var s = t === null || t === undefined ? '' : String(t).trim();
    if (/^\d{3,4}$/.test(s)) { var h = +s.slice(0, s.length - 2), mi = +s.slice(-2); if (h < 24 && mi < 60) return (h < 10 ? '0' : '') + h + ':' + s.slice(-2); return null; }
    return norm(s);
  }
  function toMin(t) { var n = norm2(t); if (!n) return null; return +n.slice(0, 2) * 60 + +n.slice(3); }
  function span(a, b) { var x = toMin(a), y = toMin(b); if (x === null || y === null) return null; var d = y - x; if (d < 0) d += 1440; return d; }
  function num(v) { if (v === null || v === undefined || String(v).trim() === '') return null; var n = Number(String(v).trim().replace(',', '.')); return isFinite(n) ? n : null; }

  /** Minutes of one meal break (a -> b) that fall inside the window [ws, ws+len] (clock times; handles past midnight). */
  function overlap(ws, len, ma, mb) {
    var a = toMin(ma), d = span(ma, mb);
    if (a === null || d === null) return 0;
    var off = ((a - ws) % 1440 + 1440) % 1440, best = 0;
    [off, off - 1440].forEach(function (s) { best += Math.max(0, Math.min(s + d, len) - Math.max(s, 0)); });
    return best;
  }
  function compute(c) {
    c = c || {};
    var stop = c.stop !== undefined ? c.stop : c.wrap; // "wrap" = old name
    var warnings = [];
    var meals = Array.isArray(c.meals) ? c.meals : [];
    var mealMin = 0;
    meals.forEach(function (ml, i) {
      if (!ml) return;
      var d = span(ml.start, ml.end);
      if (d !== null) mealMin += d;
      else if (toMin(ml.start) !== null || toMin(ml.end) !== null) warnings.push('Meal ' + (i + 1) + ' needs a start and an end');
    });
    var shift = span(c.start, stop);
    var totalMin = shift === null ? null : Math.max(0, shift - mealMin);
    if (shift === null && (toMin(c.start) !== null) !== (toMin(stop) !== null)) warnings.push(toMin(c.start) === null ? 'Add a start time' : 'Add a stop time');
    var onSetRaw = span(c.on_set, c.wheels_up), onSiteMin = null, onSetMealMin = 0;
    if (onSetRaw !== null) {
      var ws = toMin(c.on_set);
      meals.forEach(function (ml) { if (ml) onSetMealMin += overlap(ws, onSetRaw, ml.start, ml.end); });
      onSiteMin = Math.max(0, onSetRaw - Math.min(onSetMealMin, onSetRaw));
    } else if ((toMin(c.on_set) !== null) !== (toMin(c.wheels_up) !== null)) warnings.push(toMin(c.on_set) === null ? 'Add an on set start time' : 'Add an on set end time');
    var override = num(c.hours_override);
    var paidMin = override !== null ? Math.round(override * 60) : totalMin;
    if (totalMin !== null && totalMin > 18 * 60) warnings.push('More than 18 hours, check the times');
    return { totalMin: totalMin, onSiteMin: onSiteMin, mealMin: mealMin, paidMin: paidMin, overridden: override !== null, warnings: warnings };
  }

  function fmt(min) {
    if (min === null || min === undefined || isNaN(min)) return '';
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return h + ':' + (m < 10 ? '0' : '') + m;
  }
  function dec(min) {
    if (min === null || min === undefined || isNaN(min)) return '';
    return (Math.round(min / 60 * 100) / 100).toString();
  }
  function ampm(t) {
    var m = toMin(t); if (m === null) return '';
    var h = Math.floor(m / 60), mi = m % 60, s = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + (mi < 10 ? '0' : '') + mi + s;
  }
  return { norm: norm2, toMin: toMin, span: span, num: num, compute: compute, fmt: fmt, dec: dec, ampm: ampm };
});
