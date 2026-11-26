import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerHealthResultSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { resolveAntigravityCommand, resolveAntigravityLaunchSpec } from '../cli.ts';
import { readAntigravityProviderUsage } from '../usage.ts';

test('Windows installer location works without agy on PATH for launch and usage', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-resolution-'));
  const env = { ...process.env, PATH: root, USERPROFILE: root, LOCALAPPDATA: root };
  const command = join(root, 'agy', 'bin', 'agy.exe');
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'agy.exe'), 'workspace executable');
    assert.equal(resolveAntigravityCommand('agy', { cwd: workspace, env }), null);
    const missingUsage = await readAntigravityProviderUsage({
      cwd: workspace,
      env,
      execFile: async () => assert.fail('usage must not execute the workspace CLI'),
    });
    assert.equal(missingUsage.usage.status, 'not_installed');

    const missingSpec = { command: 'agy', args: ['acp'], cwd: workspace, env };
    resolveAntigravityLaunchSpec({
      params: {
        cwd: workspace,
        options: {
          providerOptions: { acpLaunchSpec: missingSpec },
          envVars: { PATH: workspace, LOCALAPPDATA: workspace },
        },
      },
    });
    assert.equal(missingSpec.command, command);

    mkdirSync(join(root, 'agy', 'bin'), { recursive: true });
    writeFileSync(command, 'fixture');
    assert.equal(resolveAntigravityCommand('agy', { env }), command);
    for (const nested of [false, true]) {
      const spec = { command: 'agy', args: ['acp'], env };
      const providerOptions = { acpLaunchSpec: spec };
      const request = { params: nested ? { options: { providerOptions } } : { providerOptions } };
      resolveAntigravityLaunchSpec(request);
      assert.equal(spec.command, command);
      assert.deepEqual(spec.args, ['acp']);
    }
    assert.equal(resolveAntigravityCommand('missing-custom-cli', { env }), null);
    let executed;
    await readAntigravityProviderUsage({ env, execFile: async executable => {
      executed = executable;
      return { stdout: '{}', stderr: '' };
    } });
    assert.equal(executed, command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launch searches the quoted Windows host PATH and ignores session PATH', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-host-path-'));
  const hostBin = join(root, 'host bin');
  const workspace = join(root, 'workspace');
  const command = join(hostBin, 'agy.exe');
  try {
    mkdirSync(hostBin);
    mkdirSync(workspace);
    writeFileSync(command, 'host executable');
    writeFileSync(join(workspace, 'agy.exe'), 'workspace executable');
    const spec = { command: 'agy', args: ['acp'], cwd: workspace, env: { Path: `"${hostBin}"` } };
    resolveAntigravityLaunchSpec({
      params: { options: { providerOptions: { acpLaunchSpec: spec }, envVars: { PATH: workspace } } },
    });
    assert.equal(spec.command, command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit executable paths are preserved', () => {
  const request = { params: { providerOptions: { acpLaunchSpec: { command: process.execPath } } } };
  resolveAntigravityLaunchSpec(request);
  assert.equal(request.params.providerOptions.acpLaunchSpec.command, process.execPath);
});

test('provider health uses one version probe and explains when agy is too old', t => {
  const root = mkdtempSync(join(tmpdir(), 'agy-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const windows = process.platform === 'win32';
  const command = join(root, windows ? 'agy.cmd' : 'agy');
  const script = windows
    ? '@echo off\r\necho %~1>>"%AGY_PROBE_LOG%"\r\necho %AGY_TEST_VERSION%\r\n'
    : '#!/bin/sh\nprintf "%s\\n" "$1" >> "$AGY_PROBE_LOG"\nprintf "%s\\n" "$AGY_TEST_VERSION"\n';
  writeFileSync(command, script, { mode: 0o755 });

  const cases = [
    ['1.4.12', 'unsupported_version'],
    ['1.5.0-rc.1', 'unsupported_version'],
    ['1.5.0', 'ready'],
    ['1.5.14', 'ready'],
    ['unknown', 'ready'],
    ['unknown', 'not_installed'],
  ];
  const requests = cases.map(([version, status], id) => JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'provider/health',
    params: {
      providerId: 'antigravity-cli',
      providerOptions: {
        acpLaunchSpec: {
          command: status === 'not_installed' ? join(root, 'missing-agy') : command,
          displayName: 'Antigravity CLI',
          args: ['acp'],
          env: { AGY_TEST_VERSION: version, AGY_PROBE_LOG: join(root, `probe-${id}`) },
        },
      },
    },
  }));
  const fixture = fileURLToPath(new URL('./health-bridge-fixture.mjs', import.meta.url));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', fixture], {
    input: requests.join('\n') + '\n', encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const responses = new Map(run.stdout.trim().split('\n').map(line => {
    const { id, result } = JSON.parse(line);
    return [id, result];
  }));
  assert.equal(responses.size, cases.length);
  for (const [id, [version, status]] of cases.entries()) {
    const { health } = providerHealthResultSchema.parse(responses.get(id));
    assert.equal(health.status, status, JSON.stringify(health));
    assert.equal(health.installedVersion, version === 'unknown' ? null : version);
    assert.equal(health.canUpdate, false);
    if (status === 'unsupported_version') {
      assert.equal(health.minimumSupportedVersion, '1.5.0');
      assert.ok(health.statusMessage.includes(version));
      assert.match(health.statusMessage, /agy update.*on that host/);
    } else {
      assert.equal(health.statusMessage, null);
    }
    const probeLog = join(root, `probe-${id}`);
    if (status === 'not_installed') {
      assert.throws(() => readFileSync(probeLog), { code: 'ENOENT' });
    } else {
      assert.deepEqual(readFileSync(probeLog, 'utf8').trim().split(/\r?\n/), ['--version']);
    }
  }
});
