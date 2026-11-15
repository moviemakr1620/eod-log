/* Shared hours maths (browser + Node). Times are "HH:MM" strings (24h, from <input type="time">).
 * Times are read in day order: leave shop -> on set -> start -> meals -> wrap -> wheels up -> return.
 * A time earlier than the one before it is treated as after midnight (so a 6pm-2am day works). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EODHours = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function toMin(t) {
    if (!t) return null;
    var m = /^(\d{1,2}):(\d{2})/.exec(String(t));
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function compute(c) {
    c = c || {};
    var seq = [];
    function add(key, v) { var m = toMin(v); if (m !== null) seq.push({ k: key, m: m }); }
    add('leave_shop', c.leave_shop);
    add('on_set', c.on_set);
    add('start', c.start);
    var meals = Array.isArray(c.meals) ? c.meals : [];
    meals.forEach(function (ml, i) { if (ml) { add('meal_s' + i, ml.start); add('meal_e' + i, ml.end); } });
    add('wrap', c.wrap);
    add('wheels_up', c.wheels_up);
    add('return_shop', c.return_shop);

    // unwrap past midnight
    var prev = null, at = {};
    seq.forEach(function (s) {
      var v = s.m;
      if (prev !== null) while (v < prev) v += 1440;
      at[s.k] = v; prev = v;
    });

    var warnings = [];
    var mealMin = 0;
    meals.forEach(function (ml, i) {
      var a = at['meal_s' + i], b = at['meal_e' + i];
      if (a !== undefined && b !== undefined) mealMin += b - a;
      else if (a !== undefined || b !== undefined) warnings.push('Meal ' + (i + 1) + ' needs a start and an end');
    });

    var workStart = at.start !== undefined ? at.start : at.on_set;
    var workEnd = at.wrap;
    var workMin = (workStart !== undefined && workEnd !== undefined) ? Math.max(0, workEnd - workStart - mealMin) : null;

    var begin = [at.leave_shop, at.on_set, at.start].filter(function (x) { return x !== undefined; })[0];
    var end = [at.return_shop, at.wheels_up, at.wrap].filter(function (x) { return x !== undefined; })[0];
    var totalMin = (begin !== undefined && end !== undefined) ? Math.max(0, end - begin - mealMin) : null;

    var override = c.hours_override === '' || c.hours_override == null ? null : Number(c.hours_override);
    if (override !== null && !isFinite(override)) override = null;
    var paidMin = override !== null ? Math.round(override * 60) : totalMin;

    if (totalMin !== null && totalMin > 18 * 60) warnings.push('More than 18 hours, check the times');
    return { totalMin: totalMin, workMin: workMin, mealMin: mealMin, paidMin: paidMin, overridden: override !== null, warnings: warnings };
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
  return { toMin: toMin, compute: compute, fmt: fmt, dec: dec, ampm: ampm };
});
