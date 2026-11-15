const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const has = (text, pattern, message) => assert.ok(pattern.test(text), message);

test('guild create and join are distinct accessible modes', () => {
  const html = read('renderer/dashboard.html');
  const js = read('renderer/dashboard.js');
  has(html, /id="guildCreatePanel"/, 'missing create panel');
  has(html, /id="guildJoinPanel" hidden/, 'join panel should start hidden');
  has(html, /id="guildCode"[^>]*disabled/, 'join code should start disabled');
  has(js, /\$\('guildCode'\)\.required = !create/, 'code must be required only in join mode');
  has(js, /mode === 'join' \? \{ code:/, 'guild create must omit code');
  has(js, /function setGuildMode\(mode(?:, focus = true)?\)/, 'guild mode switch missing');
});

test('live stats use authoritative snapshots and no full elapsed double-count', () => {
  const js = read('renderer/dashboard.js');
  has(js, /state\.timer\?\.liveTodaySeconds/, 'today total should use authoritative timer data');
  has(js, /state\.timer\?\.liveWeekSeconds/, 'week total should use authoritative timer data');
  has(js, /liveTotalSeconds/, 'all-time total should use authoritative timer data');
  assert.doesNotMatch(js, /seconds: d\.isToday \? d\.seconds \+ liveSeconds\(\)/);
});

test('history supports filtering and session correction through the bridge', () => {
  const html = read('renderer/dashboard.html');
  const js = read('renderer/dashboard.js');
  has(html, /id="historySearch"/, 'history search control missing');
  has(html, /id="historySubject"/, 'history subject filter missing');
  has(js, /window\.api\.updateSession\(editingSessionId, changes\)/, 'session editor bridge call missing');
  assert.doesNotMatch(js, /\.slice\(0, 200\)/);
});

test('overlay presets and accessible micro controls are present', () => {
  const html = read('renderer/dashboard.html');
  const overlay = read('renderer/overlay.js');
  has(html, /id="overlayPreset"/, 'overlay size choice missing');
  has(html, /value="micro"/, 'micro preset missing');
  has(overlay, /setAttribute\('aria-label', actionName\)/, 'timer action needs stateful accessible label');
  has(overlay, /setPointerCapture/, 'resize grip must use pointer capture');
});
