'use strict';

function localDateStr(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function allocateIntervals(intervals) {
  const millis = new Map();
  for (const { startedAt, endedAt } of intervals) {
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) continue;
    let cursor = startedAt;
    while (cursor < endedAt) {
      const date = new Date(cursor);
      const key = localDateStr(date);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const end = Math.min(endedAt, midnight);
      millis.set(key, (millis.get(key) || 0) + end - cursor);
      cursor = end;
    }
  }
  return new Map([...millis].map(([date, ms]) => [date, Math.floor(ms / 1000)]));
}

function sessionSlices(intervals) {
  const buckets = new Map();
  for (const { startedAt, endedAt } of intervals) {
    let cursor = startedAt;
    while (cursor < endedAt) {
      const d = new Date(cursor);
      const date = localDateStr(d);
      const end = Math.min(endedAt, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
      const row = buckets.get(date) || { date, milliseconds: 0, startedAt: cursor, endedAt: end };
      row.milliseconds += end - cursor;
      row.startedAt = Math.min(row.startedAt, cursor);
      row.endedAt = Math.max(row.endedAt, end);
      buckets.set(date, row);
      cursor = end;
    }
  }
  const rows = [...buckets.values()].map(({ milliseconds, ...row }) => ({ ...row, seconds: Math.floor(milliseconds / 1000), remainderMs: milliseconds % 1000 }));
  const exactTotal = Math.floor(intervals.reduce((n, s) => n + Math.max(0, s.endedAt - s.startedAt), 0) / 1000);
  let remainder = exactTotal - rows.reduce((n, row) => n + row.seconds, 0);
  for (const row of [...rows].sort((a, b) => b.remainderMs - a.remainderMs || a.date.localeCompare(b.date))) {
    if (remainder <= 0) break;
    row.seconds += 1;
    remainder -= 1;
  }
  return rows.filter((row) => row.seconds > 0).map(({ remainderMs, ...row }) => row);
}

module.exports = { localDateStr, allocateIntervals, sessionSlices };
