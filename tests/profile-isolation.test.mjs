import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const fixturePath = fileURLToPath(new URL('./profile-bridge-fixture.mjs', import.meta.url));
const fakeAgyPath = fileURLToPath(new URL('./fake-profile-agy.mjs', import.meta.url));

function writeWrapper(binDir, body) {
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const filePath = join(binDir, 'agy.cmd');
    writeFileSync(filePath, `@echo off\r\n${body}\r\n`);
    return filePath;
  }
  const filePath = join(binDir, 'agy');
  writeFileSync(filePath, `#!/bin/sh\n${body}\n`);
  chmodSync(filePath, 0o755);
  return filePath;
}

function writeSyntheticAccount(appDataDir, account) {
  mkdirSync(appDataDir, { recursive: true });
  writeFileSync(join(appDataDir, 'synthetic-account.json'), JSON.stringify(account));
}

function createSyntheticWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'agy-profile-isolation-'));
  const hostBin = join(root, 'host-bin');
  const emptyHostBin = join(root, 'empty-host-bin');
  const untrustedBin = join(root, 'untrusted-bin');
  const defaultHome = join(root, 'default-home');
  const alphaGeminiDir = join(root, 'profile-alpha', '.gemini');
  const betaGeminiDir = join(root, 'profile-beta-root');
  const untrustedFlag = join(root, 'untrusted-executed.txt');

  mkdirSync(emptyHostBin, { recursive: true });
  writeWrapper(
    hostBin,
    process.platform === 'win32'
      ? `"${process.execPath}" "${fakeAgyPath}" %*`
      : `exec "${process.execPath}" "${fakeAgyPath}" "$@"`,
  );
  writeWrapper(
    untrustedBin,
    process.platform === 'win32'
      ? `echo executed>"${untrustedFlag}"\r\nexit /b 99`
      : `echo executed > "${untrustedFlag}"\nexit 99`,
  );

  writeSyntheticAccount(join(defaultHome, '.gemini', 'antigravity-cli'), {
    accountId: 'synthetic-default',
    gemini7dRemaining: 0.01,
    claude5hRemaining: 0.02,
  });
  writeSyntheticAccount(join(alphaGeminiDir, 'antigravity-cli'), {
    accountId: 'synthetic-alpha',
    gemini7dRemaining: 0.80,
    claude5hRemaining: 0.85,
  });
  writeSyntheticAccount(join(betaGeminiDir, 'work-app'), {
    accountId: 'synthetic-beta',
    gemini7dRemaining: 0.25,
    claude5hRemaining: 0.40,
  });

  return root;
}

async function runPhase(mode, root) {
  const result = await run(
    process.execPath,
    ['--experimental-strip-types', fixturePath, mode, root],
    {
      timeout: 45_000,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: mode === 'missing-host-agy' ? join(root, 'empty-host-bin') : join(root, 'host-bin'),
        HOME: join(root, 'default-home'),
        USERPROFILE: join(root, 'default-home'),
        LOCALAPPDATA: join(root, 'default-home'),
      },
    },
  );
  assert.match(result.stdout, /verified/, result.stderr);
}

test('unresolved host agy fails with an installation diagnostic and never uses session PATH', async () => {
  const root = createSyntheticWorkspace();
  try {
    await runPhase('missing-host-agy', root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('routed stop force-terminates a CLI that ignores cancellation with a steer queued', async t => {
  const root = createSyntheticWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await runPhase('unresponsive-stop', root);
});

test('routing survives host restarts without valid local binding state', async t => {
  const root = createSyntheticWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // A directory at the old binding path prevents the prototype from writing the binding.
  const oldBindingPath = join(root, 'state', 'session-profiles.json');
  const invocationsPath = join(root, 'invocations.jsonl');
  mkdirSync(oldBindingPath, { recursive: true });
  await runPhase('phase1-start', root);
  rmSync(oldBindingPath, { recursive: true });
  rmSync(invocationsPath, { force: true });
  await runPhase('phase2-restart-and-resume', root);

  writeFileSync(oldBindingPath, 'corrupt');
  rmSync(invocationsPath, { force: true });
  await runPhase('resume-with-corrupt-binding', root);
});
