'use strict';
const path = require('node:path');

function writeJsonAtomically(file, value, fsImpl = require('node:fs')) {
  const tmp = `${file}.tmp`;
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    if (fsImpl.existsSync(file)) fsImpl.copyFileSync(file, `${file}.bak`);
    fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fsImpl.renameSync(tmp, file);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not save your data. Check available disk space and file permissions.' };
  }
}

module.exports = { writeJsonAtomically };
