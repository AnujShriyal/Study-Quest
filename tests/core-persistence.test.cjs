'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomically } = require('../lib/core-persistence.cjs');

test('atomic writes keep a rolling last-known-good backup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-quest-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');
  assert.deepEqual(writeJsonAtomically(file, { revision: 1 }), { ok: true });
  assert.deepEqual(writeJsonAtomically(file, { revision: 2 }), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).revision, 1);
});

test('a failed atomic write leaves the committed file intact and returns an error', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-quest-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');
  writeJsonAtomically(file, { revision: 1 });
  const failingFs = Object.create(fs);
  failingFs.renameSync = () => { throw new Error('simulated disk failure'); };
  const result = writeJsonAtomically(file, { revision: 2 }, failingFs);
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).revision, 1);
});
