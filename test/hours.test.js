const test = require('node:test');
const assert = require('node:assert');
const H = require('../public/hours.js');

test('start/stop, no meal: nothing deducted', () => {
  const r = H.compute({ start: '08:00', stop: '18:00' });
  assert.equal(r.totalMin, 600); assert.equal(r.paidMin, 600); assert.equal(r.mealMin, 0);
});
test('meal deducted only when entered', () => {
  assert.equal(H.compute({ start: '08:00', stop: '18:00', meals: [{ start: '12:00', end: '12:30' }] }).paidMin, 570);
  assert.equal(H.compute({ start: '08:00', stop: '18:00', meals: [{ start: '', end: '' }] }).paidMin, 600);
});
test('travel / on-site times never change hours', () => {
  const r = H.compute({ leave_shop: '05:00', on_set: '07:00', start: '07:30', stop: '18:00', wheels_up: '19:00', return_shop: '21:00' });
  assert.equal(r.paidMin, 630); assert.equal(r.onSiteMin, 720);
});
test('overnight: stop before start', () => {
  assert.equal(H.compute({ start: '18:00', stop: '02:00' }).paidMin, 480);
  assert.equal(H.compute({ start: '18:00', meals: [{ start: '23:30', end: '00:15' }], stop: '03:00' }).paidMin, 9 * 60 - 45);
});
test('old "wrap" field still works', () => { assert.equal(H.compute({ start: '09:00', wrap: '17:00' }).paidMin, 480); });
test('override wins', () => { assert.equal(H.compute({ start: '09:00', stop: '17:00', hours_override: '10,5' }).paidMin, 630); });
test('time formats from different browsers', () => {
  const cases = { '07:30': '07:30', '7:30': '07:30', '07:30:00': '07:30', '07:30:00.000': '07:30', '7:30 PM': '19:30', '7:30pm': '19:30', '12:15 AM': '00:15', '12:00pm': '12:00', '730': '07:30', '1930': '19:30', '7pm': '19:00', '': null, 'abc': null, '25:00': null, '7': '07:00', '19': '19:00', '7:30p': '19:30', '7a': '07:00' };
  for (const [k, v] of Object.entries(cases)) assert.equal(H.norm(k), v, k);
  assert.equal(H.compute({ start: '07:30:00', stop: '18:00:00.000' }).paidMin, 630);
});
test('half-entered warns', () => {
  assert.equal(H.compute({ start: '09:00' }).warnings[0], 'Add a stop time');
  assert.equal(H.compute({ start: '09:00', stop: '17:00', meals: [{ start: '12:00' }] }).warnings.length, 1);
});
test('format', () => { assert.equal(H.fmt(630), '10:30'); assert.equal(H.dec(630), '10.5'); assert.equal(H.ampm('13:05'), '1:05pm'); });

// ---- on set hours: on set start -> on set end, minus meals that fall inside; total hours stay Stop - Start - meals
test('on set hours take out a meal that falls inside the on set window; total hours are separate', () => {
  const r = H.compute({ start: '07:00', stop: '17:00', on_set: '08:00', wheels_up: '16:00', meals: [{ start: '12:00', end: '12:30' }] });
  assert.equal(r.paidMin, 570); assert.equal(r.onSiteMin, 450);
});
test('on set hours: meal outside the window is not taken out, a partly inside meal only counts the inside part', () => {
  assert.equal(H.compute({ start: '07:00', stop: '17:00', on_set: '08:00', wheels_up: '11:00', meals: [{ start: '12:00', end: '12:30' }] }).onSiteMin, 180);
  assert.equal(H.compute({ start: '07:00', stop: '17:00', on_set: '08:00', wheels_up: '12:15', meals: [{ start: '12:00', end: '12:30' }] }).onSiteMin, 240);
  assert.equal(H.compute({ start: '07:00', stop: '17:00', on_set: '08:00', wheels_up: '16:00', meals: [{ start: '07:30', end: '08:30' }] }).onSiteMin, 450);
});
test('on set hours: no meals, overnight, and meals past midnight', () => {
  assert.equal(H.compute({ on_set: '07:30', wheels_up: '18:00' }).onSiteMin, 630);
  assert.equal(H.compute({ on_set: '20:00', wheels_up: '03:00' }).onSiteMin, 420);
  assert.equal(H.compute({ start: '19:00', stop: '04:00', on_set: '20:00', wheels_up: '03:00', meals: [{ start: '23:30', end: '00:30' }] }).onSiteMin, 360);
  assert.equal(H.compute({ on_set: '08:00' }).onSiteMin, null);
  assert.equal(H.compute({ on_set: '08:00' }).warnings[0], 'Add an on set end time');
  assert.equal(H.compute({ wheels_up: '08:00' }).warnings[0], 'Add an on set start time');
});
