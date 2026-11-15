const test = require('node:test');
const assert = require('node:assert');
const H = require('../public/hours.js');

test('simple day with one meal', () => {
  const r = H.compute({ start: '08:00', meals: [{ start: '12:00', end: '12:30' }], wrap: '18:00' });
  assert.equal(r.workMin, 570); assert.equal(r.totalMin, 570); assert.equal(r.mealMin, 30);
});
test('shop to shop with travel and two meals', () => {
  const r = H.compute({ leave_shop: '06:00', on_set: '07:15', start: '07:30', meals: [{ start: '12:00', end: '12:30' }, { start: '18:00', end: '18:30' }], wrap: '20:00', wheels_up: '20:45', return_shop: '22:00' });
  assert.equal(r.workMin, 750 - 60); assert.equal(r.totalMin, 16 * 60 - 60);
});
test('past midnight', () => {
  const r = H.compute({ start: '18:00', meals: [{ start: '23:30', end: '00:15' }], wrap: '03:00' });
  assert.equal(r.mealMin, 45); assert.equal(r.workMin, 9 * 60 - 45);
});
test('override wins for paid', () => {
  const r = H.compute({ start: '09:00', wrap: '17:00', hours_override: '10.5' });
  assert.equal(r.paidMin, 630); assert.equal(r.workMin, 480);
});
test('half meal warns', () => {
  const r = H.compute({ start: '09:00', meals: [{ start: '12:00' }], wrap: '17:00' });
  assert.equal(r.warnings.length, 1); assert.equal(r.workMin, 480);
});
test('format', () => { assert.equal(H.fmt(630), '10:30'); assert.equal(H.dec(630), '10.5'); assert.equal(H.ampm('13:05'), '1:05pm'); });
