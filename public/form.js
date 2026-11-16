/* New / edit EOD form. Crew and expense rows are rendered here; the server gets them as JSON in hidden fields. */
(function () {
  var init = JSON.parse(document.getElementById('init').textContent);
  var form = document.getElementById('eod');
  var crewList = document.getElementById('crew-list');
  var expList = document.getElementById('exp-list');
  var H = window.EODHours;
  var TIMES = ['start', 'stop', 'on_set', 'wheels_up'];
  var seq = 0;
  var busy = 0;
  var deleteReceipts = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  function q(root, sel) { return root.querySelector(sel); }
  function qa(root, sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  // Touch phones get the native time wheel (it always gives a full time). Desktop browsers get a text field instead:
  // their native time inputs show "--:--" segments and stay EMPTY if only the hour is changed, so nothing saved.
  var TOUCH = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  function shown(v) { var n = H.norm(v); if (!n) return v || ''; if (TOUCH) return n; return H.ampm(n).replace(/(am|pm)$/, function (x) { return ' ' + x.toUpperCase(); }); }
  function tin(attr, v) {
    return TOUCH ? '<input type="time" ' + attr + ' value="' + esc(H.norm(v) || '') + '">'
      : '<input type="text" class="tfield" ' + attr + ' value="' + esc(shown(v)) + '" placeholder="hh:mm" list="dl-times" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next">';
  }
  function setVal(input, v) { input.value = shown(v || ''); input.classList.remove('bad'); }
  function badTime(input) { return (input.validity && input.validity.badInput) || (input.value.trim() !== '' && !H.norm(input.value)); }
  function timeInput(f, label, v) { return '<label>' + label + tin('data-f="' + f + '"', v) + '</label>'; }
  if (!TOUCH) { // quick picker: 15-minute steps as suggestions under each time field
    var dlt = document.createElement('datalist'); dlt.id = 'dl-times';
    for (var mm = 0; mm < 1440; mm += 15) { var o = document.createElement('option'); o.value = shown((mm < 600 ? '0' : '') + Math.floor(mm / 60) + ':' + (mm % 60 < 10 ? '0' : '') + mm % 60); dlt.appendChild(o); }
    document.body.appendChild(dlt);
    form.addEventListener('focusout', function (ev) {
      var i = ev.target; if (!i.classList || !i.classList.contains('tfield')) return;
      var n = H.norm(i.value);
      if (n) { i.value = shown(n); i.classList.remove('bad'); } else i.classList.toggle('bad', i.value.trim() !== '');
      var row = i.closest('.crew-row'); if (row) updateCrew(row);
    });
    form.addEventListener('input', function (ev) { if (ev.target.classList && ev.target.classList.contains('tfield')) ev.target.classList.remove('bad'); });
  }

  // ---------- crew
  function mealHtml(m) {
    m = m || {};
    return '<div class="meal"><label>Meal start' + tin('data-m="start"', m.start) + '</label>' +
      '<label>Meal end' + tin('data-m="end"', m.end) + '</label>' +
      '<button type="button" class="rm-meal" aria-label="Remove meal">×</button></div>';
  }
  function siteHtml(c) {
    return '<div class="site"><label>On site' + tin('data-f="on_set"', c.on_set) + '</label>' +
      '<label>Off site' + tin('data-f="wheels_up"', c.wheels_up) + '</label>' +
      '<button type="button" class="rm-site" aria-label="Remove site time">×</button></div>';
  }
  function setSite(row, c) {
    var box = q(row, '.sitebox'); box.innerHTML = '';
    if (c && (c.on_set || c.wheels_up)) box.appendChild(el(siteHtml(c)));
    q(row, '.addsite').hidden = !!q(row, '.site');
  }
  function addCrew(c, focus) {
    c = c || {}; var id = ++seq;
    if (c.stop === undefined && c.wrap !== undefined) c.stop = c.wrap; // drafts from the old form
    var moreOpen = c.role || c.hours_override != null && c.hours_override !== '' || c.edit_hours != null && c.edit_hours !== '' || c.note;
    var row = el('<div class="crew-row" data-id="' + id + '" data-leave="' + esc(c.leave_shop) + '" data-return="' + esc(c.return_shop) + '">' +
      '<div class="head"><label>Name<input data-f="name" list="dl-people" autocomplete="off" autocapitalize="words" value="' + esc(c.name) + '" placeholder="Crew member"></label>' +
      '<button type="button" class="rm" aria-label="Remove this person">×</button></div>' +
      '<div class="row2">' + timeInput('start', 'Start', c.start) + timeInput('stop', 'Stop', c.stop) + '</div>' +
      '<div class="tot"><span>Hours <span class="muted small" data-detail></span></span><b data-total>–</b></div><div class="warn" data-warn></div>' +
      '<div class="meals stack"></div><div class="sitebox"></div>' +
      '<div class="addbtns"><button type="button" class="btn addmeal">+ Add meal break</button><button type="button" class="btn addsite">+ Add site time</button></div>' +
      '<details' + (moreOpen ? ' open' : '') + '><summary>More: role, edit/DIT, hours override, note</summary><div class="stack">' +
      '<div class="row2"><label>Role<input data-f="role" list="dl-roles" autocomplete="off" value="' + esc(c.role) + '" placeholder="e.g. A1, Camera"></label>' +
      '<label>Edit / DIT hrs<input data-f="edit_hours" inputmode="decimal" value="' + esc(c.edit_hours) + '" placeholder="0"></label></div>' +
      '<label>Hours, if not using start/stop<input data-f="hours_override" inputmode="decimal" value="' + esc(c.hours_override) + '" placeholder="Leave empty to use start/stop"></label>' +
      '<label>Note for this person<input data-f="note" value="' + esc(c.note) + '"></label>' +
      '</div></details></div>');
    var meals = q(row, '.meals');
    (c.meals || []).forEach(function (m) { if (m && (m.start || m.end)) meals.appendChild(el(mealHtml(m))); });
    syncMealBtn(row);
    setSite(row, c);
    crewList.appendChild(row);
    updateCrew(row);
    if (focus) q(row, '[data-f=name]').focus();
    return row;
  }
  function syncMealBtn(row) { q(row, '.addmeal').textContent = q(row, '.meal') ? '+ Another meal break' : '+ Add meal break'; }
  function readCrew(row) {
    var c = { meals: [] };
    qa(row, '[data-f]').forEach(function (i) {
      var f = i.getAttribute('data-f'), v = i.value.trim();
      var isTime = i.type === 'time' || i.classList.contains('tfield');
      c[f] = isTime ? (H.norm(v) || '') : v;
      if (isTime && badTime(i)) c._bad = (c._bad || []).concat(f);
    });
    if (!q(row, '.site')) { c.on_set = ''; c.wheels_up = ''; }
    // old entries: keep any saved leave-shop / return-to-shop values untouched (no longer shown)
    if (row.getAttribute('data-leave')) c.leave_shop = row.getAttribute('data-leave');
    if (row.getAttribute('data-return')) c.return_shop = row.getAttribute('data-return');
    qa(row, '.meal').forEach(function (m) { c.meals.push({ start: H.norm(q(m, '[data-m=start]').value) || '', end: H.norm(q(m, '[data-m=end]').value) || '' }); });
    return c;
  }
  function updateCrew(row) {
    var r = H.compute(readCrew(row));
    q(row, '[data-total]').textContent = r.paidMin == null ? '–' : H.fmt(r.paidMin) + ' (' + H.dec(r.paidMin) + ' h)';
    var bits = [];
    if (r.overridden) bits.push('typed in');
    if (r.onSiteMin != null) bits.push(H.dec(r.onSiteMin) + ' h on site');
    if (r.mealMin) bits.push(H.dec(r.mealMin) + ' h meal');
    q(row, '[data-detail]').textContent = bits.length ? '(' + bits.join(', ') + ')' : '';
    q(row, '[data-warn]').textContent = r.warnings.join('. ');
    updateTotals();
  }
  function updateTotals() {
    var sum = 0, n = 0;
    qa(crewList, '.crew-row').forEach(function (row) { var r = H.compute(readCrew(row)); if (r.paidMin) { sum += r.paidMin; n++; } });
    document.getElementById('crew-total').textContent = n ? H.dec(sum) + ' crew hrs' : '';
  }
  function onEdit(ev) { var row = ev.target.closest && ev.target.closest('.crew-row'); if (row) updateCrew(row); }
  crewList.addEventListener('input', onEdit);
  crewList.addEventListener('change', onEdit); // iOS time wheels fire change
  crewList.addEventListener('click', function (ev) {
    var row = ev.target.closest('.crew-row'); if (!row) return;
    if (ev.target.closest('.rm')) {
      if (qa(crewList, '.crew-row').length === 1) { qa(row, 'input').forEach(function (i) { i.value = ''; }); q(row, '.meals').innerHTML = ''; setSite(row, null); syncMealBtn(row); updateCrew(row); }
      else { row.remove(); updateTotals(); }
      saveDraft();
    } else if (ev.target.closest('.addmeal')) {
      var m = el(mealHtml({})); q(row, '.meals').appendChild(m); syncMealBtn(row); q(m, 'input').focus(); updateCrew(row);
    } else if (ev.target.closest('.addsite')) {
      q(row, '.sitebox').appendChild(el(siteHtml({}))); q(row, '.addsite').hidden = true; q(row, '.site input').focus(); updateCrew(row);
    } else if (ev.target.closest('.rm-site')) {
      setSite(row, null); updateCrew(row); saveDraft();
    } else if (ev.target.closest('.rm-meal')) {
      ev.target.closest('.meal').remove(); syncMealBtn(row); updateCrew(row); saveDraft();
    }
  });
  function timesOf(row) { var c = readCrew(row), t = { meals: c.meals }; TIMES.forEach(function (f) { t[f] = c[f]; }); return t; }
  function applyTimes(row, t) {
    setVal(q(row, '[data-f=start]'), t.start); setVal(q(row, '[data-f=stop]'), t.stop);
    setSite(row, t);
    var meals = q(row, '.meals'); meals.innerHTML = '';
    t.meals.forEach(function (m) { meals.appendChild(el(mealHtml(m))); });
    syncMealBtn(row);
    updateCrew(row);
  }
  document.getElementById('add-crew').addEventListener('click', function () {
    var first = q(crewList, '.crew-row');
    var row = addCrew({}, true);
    if (first) applyTimes(row, timesOf(first));
    saveDraft();
  });
  document.getElementById('copy-times').addEventListener('click', function () {
    var rows = qa(crewList, '.crew-row'); if (rows.length < 2) { flash(this, 'Add more crew first'); return; }
    var t = timesOf(rows[0]);
    rows.slice(1).forEach(function (r) { applyTimes(r, t); });
    flash(this, 'Copied to ' + (rows.length - 1)); saveDraft();
  });
  function flash(btn, text) { var o = btn.textContent; btn.textContent = text; setTimeout(function () { btn.textContent = o; }, 1400); }

  // ---------- expenses
  function addExp(x, focus) {
    x = x || {}; var key = 'k' + (++seq);
    var personal = x.paid_by === 'personal';
    var row = el('<div class="exp-row" data-key="' + key + '"' + (x.id ? ' data-id="' + x.id + '"' : '') + '>' +
      '<div class="row2"><label>Amount ($)<input data-x="amount" inputmode="decimal" value="' + esc(x.amount) + '" placeholder="0.00"></label>' +
      '<label>Category<select data-x="category"><option value="">–</option>' + init.categories.map(function (c) { return '<option' + (c === x.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label></div>' +
      '<label>What for<input data-x="description" value="' + esc(x.description) + '" placeholder="e.g. Gas for Sprinter, gaff tape"></label>' +
      '<label>Who paid<input data-x="person" list="dl-people" autocomplete="off" autocapitalize="words" value="' + esc(x.person || (x.id ? '' : init.me || '')) + '"></label>' +
      '<div class="seg" role="radiogroup" aria-label="Paid with"><label><input type="radio" name="pb_' + key + '" value="company"' + (personal ? '' : ' checked') + '>Company card</label>' +
      '<label><input type="radio" name="pb_' + key + '" value="personal"' + (personal ? ' checked' : '') + '>Personal (reimburse)</label></div>' +
      '<label class="filebox">Receipt photo or PDF<input type="file" name="file_x' + key.slice(1) + '" accept="image/*,application/pdf" multiple data-compress><span class="filelist"></span></label>' +
      (x.receipts && x.receipts.length ? '<div class="rcpts">' + x.receipts.map(function (r) {
        return '<figure class="rcpt">' + (/^image\//.test(r.mime) ? '<a href="/r/' + r.id + '" target="_blank" rel="noopener"><img src="/r/' + r.id + '" alt="Receipt"></a>' : '<a class="pdf" href="/r/' + r.id + '" target="_blank" rel="noopener">PDF</a>') +
          '<figcaption>' + esc(r.original) + '</figcaption><label class="del"><input type="checkbox" data-del-receipt="' + r.id + '"> remove</label></figure>';
      }).join('') + '</div>' : '') +
      '<button type="button" class="btn danger rm-exp">Remove expense</button></div>');
    expList.appendChild(row);
    if (focus) q(row, '[data-x=amount]').focus();
    updateExpTotal();
  }
  function updateExpTotal() {
    var sum = 0;
    qa(expList, '[data-x=amount]').forEach(function (i) { var n = parseFloat(i.value.replace(/[$,]/g, '')); if (isFinite(n)) sum += n; });
    document.getElementById('exp-total').textContent = sum ? '$' + sum.toFixed(2) : '';
  }
  expList.addEventListener('input', updateExpTotal);
  expList.addEventListener('click', function (ev) {
    if (ev.target.closest('.rm-exp')) { var row = ev.target.closest('.exp-row'); if (!row.querySelector('input[type=file]').files.length || confirm('Remove this expense and its new receipt?')) { row.remove(); updateExpTotal(); saveDraft(); } }
  });
  document.getElementById('add-exp').addEventListener('click', function () { addExp({}, true); });

  // ---------- image downscale before upload (big phone photos -> ~2000px JPEG)
  form.addEventListener('change', function (ev) {
    var input = ev.target;
    if (!input.matches('input[type=file][data-compress]')) return;
    var list = input.parentNode.querySelector('.filelist');
    var files = Array.prototype.slice.call(input.files);
    if (!files.length || typeof DataTransfer === 'undefined') { showFiles(input, list); return; }
    busy++; setBusy();
    if (list) list.textContent = ' Preparing ' + files.length + ' file(s)…';
    Promise.all(files.map(shrink)).then(function (out) {
      try { var dt = new DataTransfer(); out.forEach(function (f) { dt.items.add(f); }); input.files = dt.files; } catch (e) { /* keep originals */ }
    }).catch(function () {}).then(function () { busy--; setBusy(); showFiles(input, list); });
  });
  function showFiles(input, list) {
    if (!list) return;
    list.textContent = Array.prototype.slice.call(input.files).map(function (f) { return ' ' + f.name + ' (' + Math.round(f.size / 1024) + ' KB)'; }).join(',');
  }
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1200000) return resolve(file);
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 2000, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) {
          if (!b || b.size >= file.size) return resolve(file);
          resolve(new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  var saveBtn = document.getElementById('save-btn'), saveLabel = saveBtn.textContent;
  function setBusy() { saveBtn.disabled = busy > 0; saveBtn.textContent = busy > 0 ? 'Preparing photos…' : saveLabel; }

  // ---------- collect + submit
  function collect() {
    var all = qa(crewList, '.crew-row').map(readCrew);
    var crew = all.filter(function (c) { return c.name; });
    var nameless = all.filter(function (c) { return !c.name && TIMES.some(function (f) { return c[f]; }); }).length;
    var exps = qa(expList, '.exp-row').map(function (row) {
      var x = { key: row.getAttribute('data-key').slice(1) };
      if (row.getAttribute('data-id')) x.id = Number(row.getAttribute('data-id'));
      qa(row, '[data-x]').forEach(function (i) { x[i.getAttribute('data-x')] = i.value.trim(); });
      var pb = q(row, 'input[type=radio]:checked'); x.paid_by = pb ? pb.value : 'company';
      x.hasFiles = row.querySelector('input[type=file]').files.length > 0;
      return x;
    });
    deleteReceipts = qa(expList, '[data-del-receipt]:checked').map(function (i) { return Number(i.getAttribute('data-del-receipt')); });
    return { crew: crew, expenses: exps, nameless: nameless, bad: all.filter(function (c) { return c._bad; }).length };
  }
  form.addEventListener('submit', function (ev) {
    var data = collect();
    var job = form.elements.job, date = form.elements.date;
    var firstNameless = qa(crewList, '.crew-row').filter(function (r) { var c = readCrew(r); return !c.name && TIMES.some(function (f) { return c[f]; }); })[0];
    var badTimes = qa(crewList, 'input[type=time], input.tfield').filter(badTime);
    badTimes.forEach(function (i) { i.classList.add('bad'); var d = i.closest('details'); if (d) d.open = true; });
    var problem = badTimes.length ? [badTimes[0], 'A time is incomplete or not understood (highlighted in red). Enter a full time like 7:30 AM, 1930 or 7:30p, or clear it.']
      : !job.value.trim() ? [job, 'Enter the job / project name.'] : !date.value ? [date, 'Pick a date.']
      : firstNameless ? [q(firstNameless, '[data-f=name]'), 'A crew row has times but no name. Add the name (or remove the row).']
      : !data.crew.length ? [q(crewList, '[data-f=name]'), 'Add at least one crew member name.'] : null;
    if (problem) { ev.preventDefault(); alert(problem[1]); problem[0].focus(); return; }
    if (busy) { ev.preventDefault(); return; }
    data.crew.forEach(function (c) { delete c._bad; });
    document.getElementById('crew_json').value = JSON.stringify(data.crew);
    document.getElementById('expenses_json').value = JSON.stringify(data.expenses);
    var d = form.querySelector('input[name=delete_receipts_json]') || form.appendChild(el('<input type="hidden" name="delete_receipts_json">'));
    d.value = JSON.stringify(deleteReceipts);
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  });

  // ---------- draft (new entries only; files can't be kept)
  var draftTimer;
  function saveDraft() {
    if (!init.draftKey) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      var fields = {};
      qa(form, 'input[name],select[name],textarea[name]').forEach(function (i) { if (i.type !== 'file' && i.type !== 'hidden' && i.type !== 'radio') fields[i.name] = i.value; });
      var d = collect();
      try { localStorage.setItem(init.draftKey, JSON.stringify({ t: Date.now(), fields: fields, crew: qa(crewList, '.crew-row').map(readCrew), expenses: d.expenses })); } catch (e) { /* full or private */ }
    }, 400);
  }
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);

  var draft = null;
  if (init.draftKey && !/[?&]from=/.test(location.search)) {
    try { draft = JSON.parse(localStorage.getItem(init.draftKey) || 'null'); } catch (e) { draft = null; }
    if (draft && Date.now() - draft.t > 3 * 86400000) draft = null;
  }
  if (draft) {
    Object.keys(draft.fields).forEach(function (n) { var i = form.elements[n]; if (i && i.type !== 'file') i.value = draft.fields[n]; });
    (draft.crew.length ? draft.crew : init.crew).forEach(function (c) { addCrew(c); });
    draft.expenses.forEach(function (x) { delete x.id; addExp(x); });
    var b = document.getElementById('draft-banner'); b.hidden = false;
    document.getElementById('draft-discard').addEventListener('click', function () { try { localStorage.removeItem(init.draftKey); } catch (e) { /* */ } location.href = '/new'; });
  } else {
    (init.crew.length ? init.crew : [{}]).forEach(function (c) { addCrew(c); });
    init.expenses.forEach(function (x) { addExp(x); });
  }
  if (init.isNew && !draft) { var j = form.elements.job; if (!j.value) j.focus(); }
})();
