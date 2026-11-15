'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateIntervals, sessionSlices } = require('../lib/core-time.cjs');

test('allocates an interval across local midnight without counting a pause gap', () => {
  const start = new Date(2026, 10, 14, 23, 59, 58).getTime();
  const midnight = new Date(2026, 10, 15, 0, 0, 0).getTime();
  const end = new Date(2026, 10, 15, 0, 0, 3).getTime();
  const got = allocateIntervals([{ startedAt: start, endedAt: midnight }, { startedAt: midnight, endedAt: end }]);
  assert.equal(got.get('2026-11-14'), 2);
  assert.equal(got.get('2026-11-15'), 3);
});

test('uses calendar boundaries across DST and ignores invalid intervals', () => {
  const start = new Date(2026, 2, 8, 1, 30).getTime();
  const end = new Date(2026, 2, 8, 3, 30).getTime();
  const got = allocateIntervals([{ startedAt: start, endedAt: end }, { startedAt: 1, endedAt: 1 }]);
  assert.equal([...got.values()][0], (end - start) / 1000);
});

test('session slices preserve the exact total seconds with finite date-clipped timestamps', () => {
  const start = new Date(2026, 10, 14, 23, 59, 58, 500).getTime();
  const end = new Date(2026, 10, 15, 0, 0, 1, 250).getTime();
  const slices = sessionSlices([{ startedAt: start, endedAt: end }]);
  assert.equal(slices.reduce((n, s) => n + s.seconds, 0), Math.floor((end - start) / 1000));
  assert.deepEqual(slices.map((s) => s.date), ['2026-11-14', '2026-11-15']);
  for (const s of slices) {
    assert.ok(Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt));
    assert.equal(new Date(s.startedAt).getFullYear(), 2026);
    assert.ok(s.endedAt > s.startedAt);
  }
});

test('session slice remainders survive many subsecond calendar-day segments', () => {
  const intervals = Array.from({ length: 8 }, (_, i) => {
    const start = new Date(2026, 10, 1 + i, 12).getTime();
    return { startedAt: start, endedAt: start + 700 };
  });
  const slices = sessionSlices(intervals);
  assert.equal(slices.reduce((n, s) => n + s.seconds, 0), 5);
});
