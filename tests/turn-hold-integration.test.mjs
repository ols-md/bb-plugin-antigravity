import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('ACP bridge keeps a turn open across background work and the CLI reactive wakeup', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-hold-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await promisify(execFile)(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('./turn-hold-fixture.mjs', import.meta.url))],
    // Keep task state and fake task logs out of the user's real plugin-data directory.
    { timeout: 45000, env: { ...process.env, BB_ANTIGRAVITY_TASK_STATE_DIR: join(dir, 'state'), FAKE_ACP_TASK_DIR: join(dir, 'tasks') } },
  );
  assert.match(result.stdout, /verified/);
});
