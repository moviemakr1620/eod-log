// One-page-ish PDF of an EOD for the Google Drive folder (pdfkit, built-in Helvetica: no fonts to ship).
const PDFDocument = require('pdfkit');
const cfg = require('./config');
const H = require('../public/hours.js');
const { prettyDate, money, tzShort } = require('./util');

const t = (v) => (v ? H.ampm(v) : '');
// Helvetica (WinAnsi) can't draw emoji etc.; keep Latin-1 + common punctuation.
const clean = (s) => String(s == null ? '' : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, '');

function entryPdf(e) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48, info: { Title: clean(`EOD ${e.date} ${e.job}`), Author: cfg.APP_NAME, Creator: cfg.APP_NAME } });
    const bufs = [];
    doc.on('data', (b) => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const need = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
    const h2 = (s) => { need(40); doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(clean(s), L, doc.y, { width: W }); doc.moveDown(0.2); };
    const kv = (pairs) => {
      pairs.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').forEach(([k, v]) => {
        const text = clean(v); doc.font('Helvetica').fontSize(10);
        const h = Math.max(doc.heightOfString(text, { width: W - 120 }), 12); need(h + 2);
        const y = doc.y;
        doc.font('Helvetica-Bold').fillColor('#6b7280').text(clean(k), L, y, { width: 115 });
        doc.font('Helvetica').fillColor('#111827').text(text, L + 120, y, { width: W - 120 });
        doc.y = y + h + 3;
      });
    };
    const table = (cols, rows) => { // cols: [label, width fraction, align]
      const ws = cols.map((c) => c[1] * W);
      const row = (cells, bold, shade) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
        const hs = cells.map((c, i) => doc.heightOfString(clean(c), { width: ws[i] - 6 }));
        const h = Math.max(12, ...hs) + 6; need(h);
        const y = doc.y;
        if (shade) doc.rect(L, y, W, h).fill('#f3f4f6');
        let x = L;
        cells.forEach((c, i) => { doc.fillColor(bold ? '#374151' : '#111827').text(clean(c), x + 3, y + 3, { width: ws[i] - 6, align: cols[i][2] || 'left' }); x += ws[i]; });
        doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
        doc.y = y + h;
      };
      row(cols.map((c) => c[0]), true, true);
      rows.forEach((r) => row(r));
    };

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(clean(e.job), L, doc.y, { width: W });
    doc.font('Helvetica').fontSize(11).fillColor('#6b7280').text(clean(`${prettyDate(e.date, true)}${e.job_type ? ' · ' + e.job_type : ''}`).replace(/·/g, '-'), { width: W });
    doc.moveDown(0.5);
    kv([['Client', e.client], ['Location', e.location], ['Crew chief', e.crew_chief], ['Time zone', e.tz ? tzShort(e.tz) : ''], ['Logged by', e.created_by]]);

    h2(`Crew & hours (${H.dec(e.paid_min) || 0} h total${e.onsite_min ? `, ${H.dec(e.onsite_min)} h on set` : ''})`);
    table([['Name', 0.17], ['Role', 0.1], ['Start-Stop', 0.17], ['Meals', 0.14], ['On set', 0.17], ['On set hrs', 0.12, 'right'], ['Total hrs', 0.13, 'right']],
      e.crew.map((c) => [c.name, c.role || '', c.start || c.stop ? `${t(c.start) || '?'}-${t(c.stop) || '?'}` : '', (c.meals || []).map((m) => `${t(m.start)}-${t(m.end)}`).join(', '),
        c.on_set || c.wheels_up ? `${t(c.on_set) || '?'}-${t(c.wheels_up) || '?'}` : '', c.onsite_min != null ? H.dec(c.onsite_min) : '',
        `${c.paid_min != null ? H.dec(c.paid_min) : '-'}${c.hours_override != null ? '*' : ''}${c.edit_hours ? ` +${c.edit_hours} edit` : ''}`]));
    const notes = e.crew.filter((c) => c.note).map((c) => [c.name, c.note]);
    if (e.crew.some((c) => c.hours_override != null)) { doc.moveDown(0.2); doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280').text('* hours typed in instead of start/stop', L); }
    if (notes.length) { doc.moveDown(0.3); kv(notes); }

    if (e.expenses.length) {
      h2(`Expenses (${money(e.expense_total)})`);
      table([['Item', 0.3], ['Category', 0.13], ['Person', 0.15], ['Paid with', 0.19], ['Files', 0.09, 'right'], ['Amount', 0.14, 'right']],
        e.expenses.map((x) => [x.description || '', x.category || '', x.person || '', x.paid_by === 'personal' ? 'Personal (reimburse)' : 'Company card',
          String(e.receipts.filter((r) => r.expense_id === x.id).length), x.amount != null ? money(x.amount) : '']));
    }
    const loose = e.receipts.filter((r) => !r.expense_id).length;
    if (loose) { doc.moveDown(0.3); doc.font('Helvetica').fontSize(9.5).fillColor('#111827').text(`${loose} receipt file${loose === 1 ? '' : 's'} not tied to an expense.`, L); }

    const veh = [['Vehicle', [e.vehicle, e.vehicle_kind].filter(Boolean).join(' (') + (e.vehicle && e.vehicle_kind ? ')' : '')], ['Driver', e.driver], ['Miles', e.miles], ['Tolls', e.tolls != null ? money(e.tolls) : '']];
    if (veh.some(([, v]) => v)) { h2('Vehicle'); kv(veh); }
    const gear = [['Media shot', e.media_taken], ['Media used', e.media_used], ['Gear requested', e.equip_requested], ['Gear provided', e.equip_provided]];
    if (gear.some(([, v]) => v)) { h2('Media & gear'); kv(gear); }
    if (e.issues || e.notes) { h2('Notes'); kv([['Issues', e.issues], ['Notes', e.notes]]); }

    doc.moveDown(1); need(30);
    doc.font('Helvetica').fontSize(8).fillColor('#9ca3af').text(clean(`${cfg.APP_NAME} · EOD #${e.id} · updated ${e.updated_at ? e.updated_at.slice(0, 16).replace('T', ' ') + ' UTC' : ''}${cfg.PUBLIC_URL ? ' · ' + cfg.PUBLIC_URL + '/e/' + e.id : ''}`).replace(/·/g, '|'), L, doc.y, { width: W });
    doc.end();
  });
}
module.exports = { entryPdf, clean };
