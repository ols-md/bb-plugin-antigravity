import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('ACP bridge delivers opt-in approval and forwards requests when disabled', async t => {
  const run = promisify(execFile);
  // The fixture registers a background task; keep its state out of the user's plugin-data directory.
  const stateDir = mkdtempSync(join(tmpdir(), 'auto-approve-state-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  for (const enabled of ['true', 'false']) {
    const result = await run(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./bridge-fixture.mjs', import.meta.url)), enabled], { timeout: 15000, env: { ...process.env, BB_ANTIGRAVITY_TASK_STATE_DIR: stateDir } });
    assert.match(result.stdout, /verified/);
  }
});
