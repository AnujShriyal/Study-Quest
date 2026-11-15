const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('real Electron dashboard and overlay renderer smoke', { timeout: 45000 }, () => {
  const electron = require('electron');
  assert.equal(typeof electron, 'string', 'Electron runtime is required for the UI smoke test');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'study-quest-ui-profile-'));
  const screenshots = path.resolve('artifacts/ui-smoke');
  fs.mkdirSync(screenshots, { recursive: true });
  const result = spawnSync(electron, [path.join(__dirname, 'ui-electron-runner.cjs')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, STUDY_QUEST_SMOKE_PROFILE: profile, STUDY_QUEST_SMOKE_SHOTS: screenshots },
    encoding: 'utf8', timeout: 40000, windowsHide: true
  });
  try {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    if (result.stdout) console.log(result.stdout.trim());
    assert.ok(fs.statSync(path.join(screenshots, 'dashboard.png')).size > 1000);
    assert.ok(fs.statSync(path.join(screenshots, 'overlay.png')).size > 1000);
    for (const name of ['guild-create.png', 'guild-join.png', 'settings.png', 'history-edit.png', 'light-theme.png', 'legacy-theme.png']) {
      assert.ok(fs.statSync(path.join(screenshots, name)).size > 1000, `missing ${name}`);
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
