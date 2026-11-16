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
  const cases = { '07:30': '07:30', '7:30': '07:30', '07:30:00': '07:30', '07:30:00.000': '07:30', '7:30 PM': '19:30', '7:30pm': '19:30', '12:15 AM': '00:15', '12:00pm': '12:00', '730': '07:30', '1930': '19:30', '7pm': '19:00', '': null, 'abc': null, '25:00': null, '7': null };
  for (const [k, v] of Object.entries(cases)) assert.equal(H.norm(k), v, k);
  assert.equal(H.compute({ start: '07:30:00', stop: '18:00:00.000' }).paidMin, 630);
});
test('half-entered warns', () => {
  assert.equal(H.compute({ start: '09:00' }).warnings[0], 'Add a stop time');
  assert.equal(H.compute({ start: '09:00', stop: '17:00', meals: [{ start: '12:00' }] }).warnings.length, 1);
});
test('format', () => { assert.equal(H.fmt(630), '10:30'); assert.equal(H.dec(630), '10.5'); assert.equal(H.ampm('13:05'), '1:05pm'); });
