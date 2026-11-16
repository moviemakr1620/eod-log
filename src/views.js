const cfg = require('./config');
const H = require('../public/hours.js');
const { html, raw, prettyDate, rangeLabel, money, addDays, TIMEZONES, tzShort, tzLabel, JOB_TYPES, EXPENSE_CATS, WDL } = require('./util');

const V = '16'; // static asset cache-buster
const icon = {
  plus: raw('<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>'),
  left: raw('<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'),
  right: raw('<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'),
  clip: raw('<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'),
  pin: raw('<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/></svg>'),
};
const typeClass = (t) => ({ 'Film shoot': 't-film', 'AV install': 't-install', 'Live event': 't-live', 'Edit / DIT': 't-edit' }[t] || 't-other');
const hrs = (min) => (min || min === 0 ? H.dec(min) + ' h' : '–');

function layout(req, { title, body, active, scripts = [], fab = true, bare = false }) {
  const nav = (href, label, key) => html`<a href="${href}" class="${active === key ? 'on' : ''}"${active === key ? raw(' aria-current="page"') : ''}>${label}</a>`;
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title ? title + ' · ' : ''}${cfg.APP_NAME}</title>
<meta name="theme-color" content="#111827"><meta name="robots" content="noindex,nofollow">
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${cfg.APP_NAME}">
<link rel="stylesheet" href="/app.css?v=${V}"></head><body class="${bare ? 'bare' : ''}">
${bare ? '' : html`<header class="top"><a class="brand" href="/">${cfg.APP_NAME}</a>
<nav class="tabs">${nav('/', 'Week', 'week')}${nav('/list', 'List', 'list')}${nav('/settings', 'Settings', 'settings')}</nav>
<a class="btn primary desk-only" href="/new">${icon.plus} New EOD</a></header>`}
<main class="wrap">${body}</main>
${fab && !bare ? html`<a class="fab" href="/new" aria-label="New end of day">${icon.plus}<span>New EOD</span></a>` : ''}
<script src="/app.js?v=${V}" defer></script>${scripts.map((s) => html`<script src="${s}?v=${V}" defer></script>`)}
</body></html>`;
}

function login({ error, name, needSetup }) {
  return layout(null, { title: 'Sign in', bare: true, fab: false, body: html`<div class="login card">
<h1>${cfg.APP_NAME}</h1><p class="muted">End of day log for the ${cfg.COMPANY} crew.</p>
${needSetup ? html`<p class="alert">The server has no <code>APP_PASSWORD</code> set yet. Add it to the container's environment and restart.</p>` : html`
${error ? html`<p class="alert" role="alert">${error}</p>` : ''}
<form method="post" action="/login" class="stack">
<label>Your name <span class="muted">(fills in forms for you)</span><input name="name" value="${name || ''}" autocomplete="name" autocapitalize="words"></label>
<label>Team password<input name="password" type="password" required autocomplete="current-password" autofocus></label>
<button class="btn primary big" type="submit">Sign in</button>
<p class="muted small">You stay signed in on this device.</p></form>`}</div>` });
}

function adminLogin({ error, next }) {
  return html`<div class="card narrow"><h1>Admin password</h1><p class="muted">Settings, sending the summary, and deleting entries need the admin password.</p>
${error ? html`<p class="alert" role="alert">${error}</p>` : ''}
<form method="post" action="/admin-login" class="stack"><input type="hidden" name="next" value="${next || '/settings'}">
<label>Admin password<input name="password" type="password" required autocomplete="current-password" autofocus></label>
<button class="btn primary big" type="submit">Continue</button></form></div>`;
}

function crewChips(e) {
  return e.crew.map((c) => html`<span class="chip">${c.name}<b>${c.paid_min != null ? H.dec(c.paid_min) : '–'}</b></span>`);
}
function entryCard(e, { showDate } = {}) {
  const owed = e.expenses.filter((x) => x.paid_by === 'personal').reduce((s, x) => s + (x.amount || 0), 0);
  return html`<a class="card entry ${typeClass(e.job_type)}" href="/e/${e.id}">
<div class="entry-head"><h3>${e.job}</h3>${e.job_type ? html`<span class="badge ${typeClass(e.job_type)}">${e.job_type}</span>` : ''}</div>
<div class="meta">${showDate ? html`<span>${prettyDate(e.date, true)}</span>` : ''}${e.client ? html`<span>${e.client}</span>` : ''}${e.location ? html`<span>${icon.pin} ${e.location}</span>` : ''}</div>
<div class="chips">${crewChips(e)}</div>
<div class="entry-foot"><span><b>${hrs(e.paid_min)}</b> crew</span>
${e.expense_total ? html`<span>${money(e.expense_total)}${owed ? html` <em class="owed">(${money(owed)} to reimburse)</em>` : ''}</span>` : ''}
${e.receipts.length ? html`<span class="muted">${icon.clip} ${e.receipts.length}</span>` : ''}</div>
${e.notes ? html`<p class="snip">${e.notes.length > 140 ? e.notes.slice(0, 140) + '…' : e.notes}</p>` : ''}</a>`;
}

function week(req, { start, s, today }) {
  const end = addDays(start, 6);
  const byDay = {};
  s.entries.forEach((e) => (byDay[e.date] = byDay[e.date] || []).push(e));
  const days = Object.keys(byDay).sort().reverse();
  const body = html`
<div class="weeknav">
<a class="iconbtn" href="/?week=${addDays(start, -7)}" aria-label="Previous week">${icon.left}</a>
<div class="weeklabel"><h1>${rangeLabel(start, end)}</h1>
<div class="weekpick"><label class="sr" for="weekpick">Jump to date</label><input type="date" id="weekpick" value="${start}" data-goto-week>
${today >= start && today <= end ? html`<span class="muted small">This week</span>` : html`<a class="small" href="/">Back to this week</a>`}</div></div>
<a class="iconbtn" href="/?week=${addDays(start, 7)}" aria-label="Next week">${icon.right}</a></div>
<div class="stats">
<div><b>${s.totals.entries}</b><span>EODs</span></div><div><b>${H.dec(s.totals.paid) || 0}</b><span>crew hrs</span></div>
<div><b>${money(s.totals.expenses) || '$0.00'}</b><span>expenses</span></div><div><b>${money(s.totals.owed) || '$0.00'}</b><span>to reimburse</span></div></div>
${s.people.length ? html`<details class="card people"><summary>Hours by person <span class="muted">(${s.people.length})</span></summary>
<table class="tbl"><thead><tr><th>Name</th><th>Days</th><th class="r">Hours</th><th class="r">Edit</th><th class="r">Reimb.</th></tr></thead><tbody>
${s.people.map((p) => html`<tr><td><a href="/list?person=${encodeURIComponent(p.name)}">${p.name}</a></td><td>${p.days || ''}</td><td class="r">${H.dec(p.paid)}</td><td class="r">${p.edit ? H.dec(p.edit) : ''}</td><td class="r">${p.owed ? money(p.owed) : ''}</td></tr>`)}
</tbody></table><p class="small"><a href="/summary?week=${start}">Weekly email preview</a> · <a href="/export/hours.csv?from=${start}&to=${end}">Hours CSV</a> · <a href="/export/expenses.csv?from=${start}&to=${end}">Expenses CSV</a></p></details>` : ''}
${days.length ? days.map((d) => html`<section class="day"><h2>${prettyDate(d)}</h2>${byDay[d].map((e) => entryCard(e))}</section>`)
    : html`<div class="empty card"><p>No EODs this week yet.</p><a class="btn primary big" href="/new">${icon.plus} New EOD</a></div>`}`;
  return layout(req, { title: 'Week', active: 'week', body });
}

function list(req, { f, r, people, page, pages }) {
  const qs = (extra) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();
  const body = html`<h1>All EODs</h1>
<form class="filters card" method="get" action="/list">
<input type="search" name="q" value="${f.q}" placeholder="Search job, client, crew, notes…" aria-label="Search">
<div class="row2"><select name="type" aria-label="Job type"><option value="">All job types</option>${JOB_TYPES.map((t) => html`<option ${f.type === t ? raw('selected') : ''}>${t}</option>`)}</select>
<select name="person" aria-label="Crew member"><option value="">Anyone</option>${people.map((p) => html`<option ${f.person === p ? raw('selected') : ''}>${p}</option>`)}</select></div>
<div class="row2"><label class="small">From<input type="date" name="from" value="${f.from}"></label><label class="small">To<input type="date" name="to" value="${f.to}"></label></div>
<div class="row2"><button class="btn primary" type="submit">Filter</button><a class="btn" href="/list">Clear</a></div></form>
<p class="muted small">${r.total} result${r.total === 1 ? '' : 's'} · <a href="/export/hours.csv?${qs({})}">Hours CSV</a> · <a href="/export/expenses.csv?${qs({})}">Expenses CSV</a></p>
${r.entries.map((e) => entryCard(e, { showDate: true }))}
${pages > 1 ? html`<nav class="pager">${page > 1 ? html`<a class="btn" href="/list?${qs({ page: page - 1 })}">‹ Newer</a>` : html`<span></span>`}<span class="muted">Page ${page} of ${pages}</span>${page < pages ? html`<a class="btn" href="/list?${qs({ page: page + 1 })}">Older ›</a>` : html`<span></span>`}</nav>` : ''}`;
  return layout(req, { title: 'List', active: 'list', body });
}

function receiptThumb(r, { del } = {}) {
  const isImg = /^image\//.test(r.mime || '');
  return html`<figure class="rcpt">${isImg ? html`<a href="/r/${r.id}" target="_blank" rel="noopener"><img src="/r/${r.id}" alt="Receipt ${r.original || ''}" loading="lazy"></a>`
    : html`<a class="pdf" href="/r/${r.id}" target="_blank" rel="noopener">PDF</a>`}
<figcaption>${r.original || 'receipt'}</figcaption>${del ? html`<label class="del"><input type="checkbox" name="delete_receipt" value="${r.id}"> remove</label>` : ''}</figure>`;
}

function detail(req, { e, isAdmin }) {
  const row = (label, v) => (v || v === 0 ? html`<div class="kv"><dt>${label}</dt><dd>${v}</dd></div>` : '');
  const t = (v) => (v ? H.ampm(v) : '');
  const general = e.receipts.filter((r) => !r.expense_id || !e.expenses.find((x) => x.id === r.expense_id));
  const vk = { company: 'Company vehicle', personal: 'Personal vehicle', rental: 'Rental' }[e.vehicle_kind];
  const body = html`<div class="detail-head"><a class="back" href="/?week=${require('./util').weekStart(e.date)}">${icon.left} Week</a></div>
${req.query && req.query.saved ? html`<p class="alert info" role="status">Saved. ${e.crew.length} crew, ${hrs(e.paid_min)} total.</p>` : ''}
<div class="card"><div class="entry-head"><h1>${e.job}</h1>${e.job_type ? html`<span class="badge ${typeClass(e.job_type)}">${e.job_type}</span>` : ''}</div>
<div class="meta"><span>${prettyDate(e.date, true)}</span>${e.client ? html`<span>${e.client}</span>` : ''}${e.location ? html`<span>${icon.pin} ${e.location}</span>` : ''}${e.tz ? html`<span>${tzLabel(e.tz)}</span>` : ''}</div>
${e.crew_chief ? html`<p class="small">Crew chief: <b>${e.crew_chief}</b></p>` : ''}</div>
<h2 class="sec">Crew &amp; hours <span class="muted">${hrs(e.paid_min)} total</span></h2>
${e.crew.map((c) => html`<div class="card crewcard"><div class="crew-top"><h3>${c.name}${c.role ? html` <span class="muted">· ${c.role}</span>` : ''}</h3><b class="hours">${hrs(c.paid_min)}</b></div>
<dl class="times">${row('Start', t(c.start))}${row('Stop', t(c.stop))}
${(c.meals || []).map((m, i) => row(`Meal ${c.meals.length > 1 ? i + 1 : ''}`, `${t(m.start) || '?'} – ${t(m.end) || '?'}`))}
${row('On site', t(c.on_set))}${row('Off site', t(c.wheels_up))}${row('On-site hours', c.onsite_min != null ? hrs(c.onsite_min) : '')}
${c.hours_override != null ? row('Hours (typed in)', c.hours_override + ' h') : ''}${row('Edit / DIT', c.edit_hours ? c.edit_hours + ' h' : '')}</dl>
${c.note ? html`<p class="small">${c.note}</p>` : ''}</div>`)}
${e.expenses.length || general.length ? html`<h2 class="sec">Expenses <span class="muted">${money(e.expense_total)}</span></h2>
${e.expenses.map((x) => { const rs = e.receipts.filter((r) => r.expense_id === x.id); return html`<div class="card exp"><div class="crew-top"><div><b>${x.description || x.category || 'Expense'}</b>
<div class="small muted">${[x.category, x.person].filter(Boolean).join(' · ')}</div></div><div class="r"><b>${money(x.amount)}</b><div class="small ${x.paid_by === 'personal' ? 'owed' : 'muted'}">${x.paid_by === 'personal' ? 'Personal: reimburse' : 'Company card'}</div></div></div>
${rs.length ? html`<div class="rcpts">${rs.map((r) => receiptThumb(r))}</div>` : html`<p class="small warn">No receipt attached</p>`}</div>`; })}
${general.length ? html`<div class="card"><b>Other receipts</b><div class="rcpts">${general.map((r) => receiptThumb(r))}</div></div>` : ''}` : ''}
${e.vehicle || e.miles || e.tolls ? html`<h2 class="sec">Vehicle</h2><dl class="card kvs">${row('Vehicle', [e.vehicle, vk].filter(Boolean).join(' · '))}${row('Driver', e.driver)}${row('Miles', e.miles)}${row('Tolls', e.tolls ? money(e.tolls) : '')}</dl>` : ''}
${e.media_taken || e.media_used || e.equip_requested || e.equip_provided ? html`<h2 class="sec">Media &amp; gear</h2><dl class="card kvs">${row('# Media taken', e.media_taken)}${row('# Media used', e.media_used)}
${row('Requested by client', e.equip_requested ? html`<span class="pre">${e.equip_requested}</span>` : '')}${row('Taken / provided & used', e.equip_provided ? html`<span class="pre">${e.equip_provided}</span>` : '')}</dl>` : ''}
${e.issues ? html`<h2 class="sec">Issues / damage</h2><div class="card pre warnbox">${e.issues}</div>` : ''}
${e.notes ? html`<h2 class="sec">Notes</h2><div class="card pre">${e.notes}</div>` : ''}
<p class="muted small">Logged by ${e.created_by || 'someone'} · ${new Date(e.created_at).toLocaleString('en-US', { timeZone: cfg.TZ, dateStyle: 'medium', timeStyle: 'short' })}${e.updated_at !== e.created_at ? html` · edited ${new Date(e.updated_at).toLocaleString('en-US', { timeZone: cfg.TZ, dateStyle: 'medium', timeStyle: 'short' })}` : ''}</p>
<div class="actions"><a class="btn primary big" href="/e/${e.id}/edit">Edit</a><a class="btn big" href="/new?from=${e.id}">Duplicate for another day</a>
${isAdmin ? html`<form method="post" action="/e/${e.id}/delete" data-confirm="Delete this EOD and its receipts? This can't be undone."><button class="btn danger big" type="submit">Delete</button></form>`
    : html`<a class="btn big" href="/admin-login?next=/e/${e.id}">Delete (admin)</a>`}</div>`;
  return layout(req, { title: e.job, body });
}

function form(req, { e, sugg, isNew, error }) {
  const opt = (arr, cur) => arr.map((v) => html`<option value="${v}"${v === cur ? raw(' selected') : ''}>${v}</option>`);
  const dl = (id, arr) => html`<datalist id="${id}">${arr.map((v) => html`<option value="${v}">`)}</datalist>`;
  const init = { crew: e.crew, expenses: e.expenses.map((x) => ({ ...x, receipts: e.receipts.filter((r) => r.expense_id === x.id).map((r) => ({ id: r.id, original: r.original, mime: r.mime })) })), me: req.session && req.session.n, isNew, draftKey: isNew ? 'eod-draft-new' : null, categories: EXPENSE_CATS };
  const optional = (id, title, open, inner) => html`<details class="card sect" id="${id}"${open ? raw(' open') : ''}><summary>${title}</summary><div class="stack">${inner}</div></details>`;
  const general = e.receipts.filter((r) => !r.expense_id || !e.expenses.find((x) => x.id === r.expense_id));
  const body = html`<h1>${isNew ? 'New end of day' : 'Edit EOD'}</h1>
${error ? html`<p class="alert" role="alert">${error}</p>` : ''}
<div id="draft-banner" class="alert info" hidden>Restored your unsaved draft. <button type="button" class="linkbtn" id="draft-discard">Start fresh</button></div>
<form id="eod" method="post" action="${isNew ? '/new' : `/e/${e.id}/edit`}" enctype="multipart/form-data" class="stack" novalidate>
<div class="card stack">
<label>Job / project<input name="job" value="${e.job || ''}" list="dl-jobs" required autocomplete="off" autocapitalize="words" placeholder="e.g. Acme product shoot"></label>
<div class="row2"><label>Date<input type="date" name="date" value="${e.date}" required></label>
<label>Job type<select name="job_type"><option value="">Choose…</option>${opt(JOB_TYPES, e.job_type)}</select></label></div>
</div>

<section class="card stack" aria-labelledby="crew-h"><div class="sec-head"><h2 id="crew-h">Crew &amp; hours</h2><span class="muted" id="crew-total"></span></div>
<p class="small muted">Everyone can have their own times. Fill in the first person, then tap <b>Copy times to everyone</b>.</p>
<div id="crew-list"></div>
<div class="row2"><button type="button" class="btn big" id="add-crew">${icon.plus} Add crew</button><button type="button" class="btn big" id="copy-times">Copy times to everyone</button></div>
</section>

${optional('sec-details', 'Job details: client, location, crew chief, time zone', !isNew && (e.client || e.location), html`
<label>Client<input name="client" value="${e.client || ''}" list="dl-clients" autocomplete="off" autocapitalize="words"></label>
<label>Location / venue<input name="location" value="${e.location || ''}" list="dl-locations" autocomplete="off"></label>
<div class="row2"><label>Crew chief<input name="crew_chief" value="${e.crew_chief || ''}" list="dl-people" autocomplete="off" autocapitalize="words"></label>
<label>Time zone<select name="tz">${TIMEZONES.map(([v, l]) => html`<option value="${v}"${v === e.tz ? raw(' selected') : ''}>${l}</option>`)}</select></label></div>`)}

<details class="card sect" id="sec-exp"${e.expenses.length || general.length ? raw(' open') : ''}><summary>Expenses &amp; receipts <span class="muted" id="exp-total"></span></summary><div class="stack">
<p class="small muted">One line per receipt. Pick <b>Personal</b> if you paid and need to be paid back.</p>
<div id="exp-list"></div><button type="button" class="btn big" id="add-exp">${icon.plus} Add expense</button>
<label class="filebox">Other receipts or photos (not tied to a line)<input type="file" name="file_g" accept="image/*,application/pdf" multiple data-compress></label>
${general.length ? html`<div class="rcpts">${general.map((r) => receiptThumb(r, { del: true }))}</div>` : ''}
</div></details>

${optional('sec-vehicle', 'Vehicle, miles & tolls', !isNew && (e.vehicle || e.miles), html`
<div class="row2"><label>Vehicle<input name="vehicle" value="${e.vehicle || ''}" list="dl-vehicles" autocomplete="off" placeholder="e.g. Sprinter 2"></label>
<label>Type<select name="vehicle_kind"><option value="">–</option><option value="company"${e.vehicle_kind === 'company' ? raw(' selected') : ''}>Company</option><option value="personal"${e.vehicle_kind === 'personal' ? raw(' selected') : ''}>Personal</option><option value="rental"${e.vehicle_kind === 'rental' ? raw(' selected') : ''}>Rental</option></select></label></div>
<label>Driver<input name="driver" value="${e.driver || ''}" list="dl-people" autocomplete="off" autocapitalize="words"></label>
<div class="row2"><label>Miles<input name="miles" value="${e.miles ?? ''}" inputmode="decimal" placeholder="0"></label>
<label>Tolls ($)<input name="tolls" value="${e.tolls ?? ''}" inputmode="decimal" placeholder="0.00"></label></div>
<p class="small muted">Paid tolls or parking yourself? Add them under Expenses as Personal so you get reimbursed.</p>`)}

${optional('sec-media', 'Media & equipment', !isNew && (e.media_taken || e.equip_provided), html`
<div class="row2"><label># Media taken<input name="media_taken" value="${e.media_taken || ''}" placeholder="e.g. 4 CFexpress"></label>
<label># Media used<input name="media_used" value="${e.media_used || ''}" placeholder="e.g. 3"></label></div>
<label>Additional equipment requested by client<textarea name="equip_requested" rows="2">${e.equip_requested || ''}</textarea></label>
<label>Additional equipment taken / provided and used<textarea name="equip_provided" rows="2">${e.equip_provided || ''}</textarea></label>`)}

${optional('sec-notes', 'Notes, issues & damage', !isNew && (e.notes || e.issues), html`
<label>Issues / damage / lost gear<textarea name="issues" rows="2" placeholder="Anything broken, missing, or a client problem">${e.issues || ''}</textarea></label>
<label>Additional notes<textarea name="notes" rows="4">${e.notes || ''}</textarea></label>`)}

<input type="hidden" name="crew_json" id="crew_json"><input type="hidden" name="expenses_json" id="expenses_json">
<div class="savebar"><a class="btn big" href="${isNew ? '/' : `/e/${e.id}`}">Cancel</a><button class="btn primary big" type="submit" id="save-btn">${isNew ? 'Save EOD' : 'Save changes'}</button></div>
</form>
${dl('dl-jobs', sugg.jobs)}${dl('dl-people', sugg.people)}${dl('dl-clients', sugg.clients)}${dl('dl-locations', sugg.locations)}${dl('dl-vehicles', sugg.vehicles)}${dl('dl-roles', sugg.roles)}
<script type="application/json" id="init">${raw(JSON.stringify(init).replace(/</g, '\\u003c'))}</script>`;
  return layout(req, { title: isNew ? 'New EOD' : 'Edit EOD', body, fab: false, scripts: ['/hours.js', '/form.js'] });
}

function settings(req, { smtp, schedules, log, msg, err, stats }) {
  const statusTag = (st) => html`<span class="tag tag-${st}">${st}</span>`;
  const period = (r) => (String(r.period_from).startsWith('test:') ? 'test' : r.period_from === r.period_to ? prettyDate(r.period_from) : `${prettyDate(r.period_from)} – ${prettyDate(r.period_to)}`);
  const body = html`<h1>Settings</h1>
${msg ? html`<p class="alert info" role="status">${msg}</p>` : ''}${err ? html`<p class="alert" role="alert">${err}</p>` : ''}
<section class="stack"><div class="sec-head"><h2>Email notifications</h2><a class="btn primary" href="/settings/n/new">${icon.plus} Add</a></div>
<p class="small muted">Each notification is its own email with its own recipients and schedule. A scheduled email is <b>skipped when there are no EODs</b> in its period.</p>
${schedules.length ? schedules.map((x) => html`<div class="card sched${x.enabled ? '' : ' off'}">
<div class="crew-top"><div><h3>${x.name}</h3><div class="small">${x.desc}</div></div>${x.enabled ? html`<span class="tag tag-sent">on</span>` : html`<span class="tag">off</span>`}</div>
<p class="small ${x.recipients ? '' : 'warn'}">${x.recipients ? html`To: ${x.recipients}` : 'No recipients yet'}${x.attach ? ' · receipts attached' : ''}</p>
${x.last ? html`<p class="small muted">Last: ${statusTag(x.last.status)} ${period(x.last)} · ${x.last.detail || ''}</p>` : html`<p class="small muted">Not run yet.</p>`}
<div class="row3"><a class="btn" href="/settings/n/${x.id}">Edit</a><a class="btn" href="/summary?n=${x.id}&back=/settings">Preview</a>
<form method="post" action="/settings/n/${x.id}/send"><button class="btn" type="submit" style="width:100%"${smtp.ok ? '' : raw(' disabled')}>Send test</button></form></div>
</div>`) : html`<div class="card empty"><p>No notifications. Add one to email a summary daily or weekly.</p></div>`}
</section>

<div class="card stack"><h2>Email server</h2>
${smtp.ok ? html`<p class="small">SMTP: <b>${smtp.host}:${smtp.port}</b>${smtp.secure ? ' (TLS)' : ''}, from <b>${smtp.from}</b>${smtp.user ? ', with login' : ''}.</p>`
    : html`<p class="alert">SMTP is not configured, so nothing is sent. Set <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> and <code>SMTP_FROM</code> in the container environment.</p>`}
<p class="small muted">"Send test" emails the notification's recipients the period it would cover right now, marked [TEST]. Open Edit to send a test to a different address.</p></div>

${log.length ? html`<details class="card"><summary>Notification log <span class="muted">(${log.length})</span></summary>
<table class="tbl"><thead><tr><th>When</th><th>Notification</th><th>Result</th></tr></thead><tbody>
${log.map((r) => html`<tr><td class="small">${new Date(r.at).toLocaleString('en-US', { timeZone: cfg.TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td class="small">${r.name}<div class="muted">${period(r)}</div></td><td class="small">${statusTag(r.status)} ${r.detail || ''}</td></tr>`)}
</tbody></table></details>` : ''}

<div class="card stack"><h2>Export</h2><p class="small"><a href="/export/hours.csv">All hours (CSV)</a> · <a href="/export/expenses.csv">All expenses (CSV)</a></p></div>
<div class="card stack danger-zone"><h2>Danger zone</h2><p class="small">${stats.entries} EOD${stats.entries === 1 ? '' : 's'}, ${stats.receipts} receipt${stats.receipts === 1 ? '' : 's'} (${fmtMB(stats.uploadBytes)}). Clearing deletes them for good; you'll get a warning and a chance to download a CSV first.</p>
<a class="btn danger big" href="/settings/clear">Clear all data…</a></div>
<div class="card stack"><h2>This device</h2><p class="small">Signed in as <b>${(req.session && req.session.n) || 'no name'}</b>${req.session && req.session.r === 'admin' ? ' (admin)' : ''}.</p>
<form method="post" action="/logout"><button class="btn big" type="submit">Sign out</button></form></div>`;
  return layout(req, { title: 'Settings', active: 'settings', body, fab: false });
}

function scheduleForm(req, { sch, isNew }) {
  const sel = (v, cur) => (String(v) === String(cur) ? raw(' selected') : '');
  const body = html`<div class="detail-head"><a class="back" href="/settings">${icon.left} Settings</a></div>
<h1>${isNew ? 'New notification' : 'Edit notification'}</h1>
<form method="post" action="${isNew ? '/settings/n/new' : `/settings/n/${sch.id}`}" class="card stack" id="sched-form">
<label>Name<input name="name" value="${sch.name}" required placeholder="e.g. Daily wrap report"></label>
<label>Send to <span class="muted">(comma or one per line)</span><textarea name="recipients" rows="3" autocapitalize="off" spellcheck="false" placeholder="manager@company.com">${sch.recipients}</textarea></label>
<label class="check"><input type="checkbox" name="enabled" value="1"${sch.enabled ? raw(' checked') : ''}> On</label>
<label>How often<select name="frequency" data-freq>
<option value="daily"${sel('daily', sch.frequency)}>Every day</option><option value="weekdays"${sel('weekdays', sch.frequency)}>Weekdays (Mon–Fri)</option><option value="weekly"${sel('weekly', sch.frequency)}>Once a week</option></select></label>
<label data-show="weekly">Day<select name="weekday">${WDL.map((d, i) => html`<option value="${i}"${sel(i, sch.weekday)}>${d}</option>`)}</select></label>
<label data-show="daily weekdays">Covers<select name="covers"><option value="today"${sel('today', sch.covers)}>That day (send in the evening)</option><option value="yesterday"${sel('yesterday', sch.covers)}>The day before (send in the morning)</option></select></label>
<p class="small muted" data-show="weekly">A weekly email covers the previous Monday–Sunday.</p>
<p class="small muted" data-show="weekdays">Monday's email also covers the weekend, so nothing is missed.</p>
<div class="row2"><label>Send at <span class="muted">(e.g. 8:00, 18:30 or 6pm)</span><input name="send_time" value="${sch.send_time}" required placeholder="hh:mm" autocomplete="off" inputmode="text"></label>
<label>Time zone<select name="tz">${TIMEZONES.map(([v, l]) => html`<option value="${v}"${sel(v, sch.tz)}>${l}</option>`)}</select></label></div>
<label class="check"><input type="checkbox" name="attach" value="1"${sch.attach ? raw(' checked') : ''}> Attach receipt files (up to 15 MB)</label>
<p class="small muted">No EODs in the period = no email. Every run is listed in the notification log on the Settings page.</p>
<button class="btn primary big" type="submit">${isNew ? 'Add notification' : 'Save'}</button></form>
${isNew ? '' : html`<form method="post" action="/settings/n/${sch.id}/send" class="card stack"><h2>Send a test</h2>
<label>To <span class="muted">(empty = the recipients above)</span><input type="email" name="to" placeholder="you@example.com" autocapitalize="off"></label>
<button class="btn big" type="submit">Send test now</button><a class="btn big" href="/summary?n=${sch.id}&back=/settings/n/${sch.id}">Preview</a></form>
<form method="post" action="/settings/n/${sch.id}/delete" data-confirm="Delete this notification?" class="actions"><button class="btn danger big" type="submit">Delete notification</button></form>`}`;
  return layout(req, { title: 'Notification', active: 'settings', body, fab: false });
}

function summaryPage(req, { s, sch, title, emailHtml, isAdmin, smtpOk, back }) {
  const days = Math.round((Date.parse(s.to) - Date.parse(s.from)) / 864e5) + 1;
  const backHref = back || (isAdmin ? (sch ? `/settings/n/${sch.id}` : '/settings') : '/');
  const backLabel = backHref === '/settings' ? 'Settings' : backHref.startsWith('/settings/n/') ? 'Notification' : 'Back';
  const nav = (dir) => `/summary?${sch ? `n=${sch.id}&` : ''}from=${addDays(s.from, dir * days)}&to=${addDays(s.to, dir * days)}${back ? '&back=' + encodeURIComponent(back) : ''}`;
  const body = html`<div class="previewbar"><a class="btn backbtn" href="${backHref}" data-back>${icon.left} ${backLabel}</a><span class="previewtag">Email preview</span></div>
<div class="weeknav"><a class="iconbtn" href="${nav(-1)}" aria-label="Previous period">${icon.left}</a>
<div class="weeklabel"><h1>${title}</h1><span class="muted small">${s.label}${s.entries.length ? '' : ' · no EODs: a scheduled send would be skipped'}</span></div>
<a class="iconbtn" href="${nav(1)}" aria-label="Next period">${icon.right}</a></div>
${isAdmin && smtpOk && sch ? html`<form method="post" action="/settings/n/${sch.id}/send" class="row2 card"><input type="hidden" name="from" value="${s.from}"><input type="hidden" name="to_date" value="${s.to}"><input type="email" name="to" placeholder="Test address (empty = recipients)" aria-label="Send to"><button class="btn primary" type="submit">Send test</button></form>` : ''}
<div class="emailprev">${raw(emailHtml)}</div>
<p class="center"><a class="btn big" href="${backHref}">${icon.left} Back to ${backLabel === 'Back' ? 'the app' : backLabel}</a></p>`;
  return layout(req, { title, active: 'settings', body, bare: true, fab: false });
}

const fmtMB = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' bytes');
function clearPage(req, { stats, needPw, error, scope }) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const body = html`<div class="detail-head"><a class="back" href="/settings">${icon.left} Settings</a></div>
<h1>Clear all data</h1>
${error ? html`<p class="alert" role="alert">${error}</p>` : ''}
<div class="card danger-zone stack">
<p class="warnbig"><b>This permanently deletes ${plural(stats.entries, 'EOD entry').replace('entrys', 'entries')}, ${plural(stats.receipts, 'receipt')} and ${fmtMB(stats.uploadBytes)} of uploaded files.</b> People will lose every logged day, hour and expense.</p>
<p class="small"><b>Download a copy first:</b> <a href="/export/hours.csv">All hours (CSV)</a> · <a href="/export/expenses.csv">All expenses (CSV)</a></p>
<p class="small muted">Before clearing, a backup copy of the database is saved in <code>/data/backups/</code> on the server (the last 3 are kept). Receipt image/PDF files are <b>not</b> in that backup; once cleared they are gone.</p>
</div>
<form method="post" action="/settings/clear" class="card stack" id="clear-form" autocomplete="off">
<fieldset class="stack plain"><legend><b>What to clear</b></legend>
<label class="check"><input type="radio" name="scope" value="entries"${scope !== 'all' ? raw(' checked') : ''}> EOD entries, expenses and receipts (keep notifications)</label>
<label class="check"><input type="radio" name="scope" value="all"${scope === 'all' ? raw(' checked') : ''}> Everything: also notifications, settings and the notification log (${plural(stats.schedules, 'notification')})</label></fieldset>
<label><span>Type <b>DELETE</b> to confirm</span><input name="confirm" required autocapitalize="characters" spellcheck="false" autocomplete="off" placeholder="DELETE"></label>
${needPw ? html`<label>Admin password<input type="password" name="password" required autocomplete="current-password"></label>` : ''}
<button class="btn dangerfill big" type="submit">Clear all data</button>
<a class="btn big" href="/settings">Cancel</a></form>`;
  return layout(req, { title: 'Clear all data', active: 'settings', body, fab: false });
}

function message(req, { title, text, back }) {
  return layout(req, { title, body: html`<div class="card narrow"><h1>${title}</h1><p>${text}</p><a class="btn big" href="${back || '/'}">Back</a></div>` });
}

module.exports = { layout, login, adminLogin, week, list, detail, form, settings, scheduleForm, summaryPage, clearPage, message, tzShort };
