import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('crafted multipart requests are contained in an isolated server process without storage side effects', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'esdms-multipart-'));
  try {
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', 'test/fixtures/multipart-security.mjs'], {
      env: { ...process.env, STORAGE_PROVIDER: 'local', STORAGE_DIR: storage },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.match(child.stdout, /MULTIPART_SECURITY_PASS/);
    assert.deepEqual(fs.readdirSync(storage), []);
  } finally { fs.rmSync(storage, { recursive: true, force: true }); }
});
