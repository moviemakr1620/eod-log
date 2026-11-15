const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./store');
const H = require('../public/hours.js');
const { esc, addDays, rangeLabel, prettyDate, money, tzShort } = require('./util');

function build(weekStartDate) {
  const from = weekStartDate, to = addDays(weekStartDate, 6);
  const entries = store.range(from, to);
  const people = {}, jobs = {};
  const person = (n) => (people[n] = people[n] || { name: n, days: new Set(), paid: 0, edit: 0, owed: 0, companyCard: 0, miles: 0, entries: 0 });
  let totalPaid = 0, totalEdit = 0, totalExp = 0, totalOwed = 0;
  const expenses = [];
  entries.forEach((e) => {
    const j = (jobs[e.job] = jobs[e.job] || { job: e.job, type: e.job_type, client: e.client, dates: new Set(), paid: 0, edit: 0, crew: new Set(), expenses: 0, ids: [] });
    j.dates.add(e.date); j.ids.push(e.id);
    e.crew.forEach((c) => {
      const p = person(c.name); p.days.add(e.date); p.entries++;
      p.paid += c.paid_min || 0; p.edit += Math.round((c.edit_hours || 0) * 60);
      j.paid += c.paid_min || 0; j.edit += Math.round((c.edit_hours || 0) * 60); j.crew.add(c.name);
      totalPaid += c.paid_min || 0; totalEdit += Math.round((c.edit_hours || 0) * 60);
    });
    if (e.vehicle_kind === 'personal' && e.miles && e.driver) person(e.driver).miles += e.miles;
    e.expenses.forEach((x) => {
      const amt = x.amount || 0; totalExp += amt; j.expenses += amt;
      const who = x.person || e.crew_chief || (e.crew[0] && e.crew[0].name) || 'Unassigned';
      if (x.paid_by === 'personal') { person(who).owed += amt; totalOwed += amt; } else person(who).companyCard += amt;
      expenses.push({ ...x, who, entry: e, receipts: e.receipts.filter((r) => r.expense_id === x.id) });
    });
  });
  const list = (o) => Object.values(o);
  return {
    from, to, label: rangeLabel(from, to), entries, expenses,
    people: list(people).map((p) => ({ ...p, days: p.days.size })).sort((a, b) => b.paid - a.paid || a.name.localeCompare(b.name)),
    jobs: list(jobs).map((j) => ({ ...j, dates: [...j.dates].sort(), crew: [...j.crew] })).sort((a, b) => a.dates[0].localeCompare(b.dates[0])),
    totals: { entries: entries.length, paid: totalPaid, edit: totalEdit, expenses: totalExp, owed: totalOwed },
  };
}

function baseUrl() { return cfg.PUBLIC_URL || `http://localhost:${cfg.PORT}`; }

/** Email-safe HTML (tables + inline styles) */
function emailHtml(s) {
  const base = baseUrl();
  const th = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid #e5e7eb;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.03em"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:14px;vertical-align:top"';
  const tdr = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:14px;text-align:right;white-space:nowrap;vertical-align:top"';
  const h2 = 'style="font-size:16px;margin:24px 0 8px;color:#111827"';
  const link = (id, text) => `<a href="${esc(base)}/e/${id}" style="color:#2563eb;text-decoration:none">${esc(text)}</a>`;
  const stat = (label, val) => `<td style="padding:8px 4px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:16px;font-weight:700;color:#111827;white-space:nowrap">${esc(val)}</div><div style="font-size:11px;color:#6b7280">${esc(label)}</div></td>`;

  let out = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;color:#111827">
<h1 style="font-size:20px;margin:0 0 4px">${esc(cfg.APP_NAME)}: weekly summary</h1>
<div style="color:#6b7280;font-size:14px;margin-bottom:16px">${esc(s.label)}</div>
<table role="presentation" cellspacing="4" cellpadding="0" style="width:100%;border-collapse:separate;table-layout:fixed"><tr>
${stat('EODs', s.totals.entries)}${stat('Crew hours', H.dec(s.totals.paid) || '0')}${stat('Edit/DIT hrs', H.dec(s.totals.edit) || '0')}${stat('Expenses', money(s.totals.expenses))}${stat('To reimburse', money(s.totals.owed))}
</tr></table>`;

  if (!s.entries.length) return out + `<p style="font-size:14px">No EODs were logged this week.</p></div>`;

  out += `<h2 ${h2}>Hours by person</h2><table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse"><tr><th ${th}>Name</th><th ${th}>Days</th><th ${th} align="right">Hours</th><th ${th} align="right">Edit/DIT</th><th ${th} align="right">Reimburse</th></tr>`;
  s.people.forEach((p) => {
    out += `<tr><td ${td}>${esc(p.name)}</td><td ${td}>${p.days || ''}</td><td ${tdr}>${H.dec(p.paid) || ''}</td><td ${tdr}>${p.edit ? H.dec(p.edit) : ''}</td><td ${tdr}>${p.owed ? '<b>' + money(p.owed) + '</b>' : ''}${p.miles ? `<div style="font-size:12px;color:#6b7280">${p.miles} personal mi</div>` : ''}</td></tr>`;
  });
  out += `</table>`;

  out += `<h2 ${h2}>Jobs</h2><table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse"><tr><th ${th}>Job</th><th ${th}>Dates</th><th ${th} align="right">Hours</th><th ${th} align="right">Expenses</th></tr>`;
  s.jobs.forEach((j) => {
    out += `<tr><td ${td}><b>${esc(j.job)}</b>${j.type ? ` <span style="color:#6b7280;font-size:12px">${esc(j.type)}</span>` : ''}${j.client ? `<div style="font-size:12px;color:#6b7280">${esc(j.client)}</div>` : ''}<div style="font-size:12px;color:#6b7280">Crew: ${esc(j.crew.join(', '))}</div></td>
<td ${td}>${j.dates.map((d) => esc(prettyDate(d))).join('<br>')}</td><td ${tdr}>${H.dec(j.paid) || ''}${j.edit ? `<div style="font-size:12px;color:#6b7280">+${H.dec(j.edit)} edit</div>` : ''}</td><td ${tdr}>${j.expenses ? money(j.expenses) : ''}</td></tr>`;
  });
  out += `</table>`;

  out += `<h2 ${h2}>Daily EODs</h2>`;
  s.entries.forEach((e) => {
    out += `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin:0 0 10px">
<div style="font-size:15px;font-weight:600">${link(e.id, e.job)} <span style="font-weight:400;color:#6b7280;font-size:13px">${esc(prettyDate(e.date))}${e.job_type ? ' · ' + esc(e.job_type) : ''}${e.location ? ' · ' + esc(e.location) : ''}</span></div>
<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:6px">`;
    e.crew.forEach((c) => {
      const times = [c.leave_shop && 'Shop ' + H.ampm(c.leave_shop), c.start && 'Start ' + H.ampm(c.start),
        ...(c.meals || []).map((m) => `Meal ${H.ampm(m.start)}–${H.ampm(m.end)}`), c.wrap && 'Wrap ' + H.ampm(c.wrap), c.return_shop && 'Return ' + H.ampm(c.return_shop)].filter(Boolean).join(' · ');
      out += `<tr><td style="padding:3px 0;font-size:13px">${esc(c.name)}${c.role ? ` <span style="color:#6b7280">(${esc(c.role)})</span>` : ''}<div style="font-size:12px;color:#6b7280">${esc(times)}${e.tz ? ' ' + esc(tzShort(e.tz)) : ''}</div></td><td style="padding:3px 0;font-size:13px;text-align:right;white-space:nowrap">${H.dec(c.paid_min)} h${c.edit_hours ? ` +${c.edit_hours} edit` : ''}</td></tr>`;
    });
    out += `</table>`;
    if (e.issues) out += `<div style="font-size:13px;margin-top:6px;color:#b91c1c"><b>Issues:</b> ${esc(e.issues)}</div>`;
    if (e.notes) out += `<div style="font-size:13px;margin-top:6px;color:#374151"><b>Notes:</b> ${esc(e.notes.length > 400 ? e.notes.slice(0, 400) + '…' : e.notes)}</div>`;
    out += `</div>`;
  });

  if (s.expenses.length) {
    out += `<h2 ${h2}>Expenses</h2><table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse"><tr><th ${th}>Item</th><th ${th}>Who / paid with</th><th ${th} align="right">Amount</th></tr>`;
    s.expenses.forEach((x) => {
      out += `<tr><td ${td}>${esc(x.description || x.category || 'Expense')}${x.category && x.description ? ` <span style="color:#6b7280;font-size:12px">${esc(x.category)}</span>` : ''}<div style="font-size:12px">${link(x.entry.id, x.entry.job + ' · ' + prettyDate(x.entry.date))}${x.receipts.length ? ` · ${x.receipts.length} receipt${x.receipts.length > 1 ? 's' : ''}` : ' · <span style="color:#b45309">no receipt</span>'}</div></td>
<td ${td}>${esc(x.who)}<div style="font-size:12px;color:${x.paid_by === 'personal' ? '#b45309' : '#6b7280'}">${x.paid_by === 'personal' ? 'Personal: reimburse' : 'Company card'}</div></td><td ${tdr}>${money(x.amount || 0)}</td></tr>`;
    });
    out += `</table>`;
  }
  out += `<p style="font-size:12px;color:#9ca3af;margin-top:24px">Hours are shop-to-shop when travel times were entered, otherwise start to wrap, minus meal breaks (or the hours a person typed in). Sent by ${esc(cfg.APP_NAME)} · <a href="${esc(base)}/?week=${s.from}" style="color:#9ca3af">open this week</a></p></div>`;
  return out;
}

function emailText(s) {
  const lines = [`${cfg.APP_NAME} weekly summary: ${s.label}`, '', `EODs: ${s.totals.entries} | Crew hours: ${H.dec(s.totals.paid) || 0} | Edit/DIT: ${H.dec(s.totals.edit) || 0} | Expenses: ${money(s.totals.expenses)} | To reimburse: ${money(s.totals.owed)}`, ''];
  if (!s.entries.length) return lines.concat('No EODs were logged this week.').join('\n');
  lines.push('HOURS BY PERSON');
  s.people.forEach((p) => lines.push(`- ${p.name}: ${H.dec(p.paid) || 0} h over ${p.days} day(s)${p.edit ? `, ${H.dec(p.edit)} edit` : ''}${p.owed ? `, reimburse ${money(p.owed)}` : ''}${p.miles ? `, ${p.miles} personal mi` : ''}`));
  lines.push('', 'JOBS');
  s.jobs.forEach((j) => lines.push(`- ${j.job}${j.type ? ' (' + j.type + ')' : ''}: ${H.dec(j.paid) || 0} h, ${j.dates.map((d) => prettyDate(d)).join(', ')}${j.expenses ? ', expenses ' + money(j.expenses) : ''}`));
  lines.push('', 'ENTRIES');
  s.entries.forEach((e) => lines.push(`- ${prettyDate(e.date)} ${e.job}: ${baseUrl()}/e/${e.id}`));
  return lines.join('\n');
}

function attachments(s, maxBytes = 15 * 1024 * 1024) {
  const out = []; let total = 0;
  s.expenses.forEach((x) => x.receipts.forEach((r) => {
    const p = path.join(cfg.UPLOAD_DIR, path.basename(r.stored));
    if (!fs.existsSync(p) || total + (r.size || 0) > maxBytes) return;
    total += r.size || 0;
    out.push({ filename: `${x.entry.date}-${(x.entry.job || 'job').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${r.id}${path.extname(r.stored)}`, path: p, contentType: r.mime });
  }));
  return out;
}

module.exports = { build, emailHtml, emailText, attachments };
