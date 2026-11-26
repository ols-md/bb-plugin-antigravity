import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerHealthResultSchema, providerInstallationStatusSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { resolveAntigravityCommand, resolveAntigravityLaunchSpec } from '../cli.ts';
import { readAntigravityProviderUsage } from '../usage.ts';

function callBridge(requests, { defaultTaskState = false, ...options } = {}) {
  const fixture = fileURLToPath(new URL('./health-bridge-fixture.mjs', import.meta.url));
  const args = ['--experimental-strip-types', fixture];
  if (defaultTaskState) args.push('--default-task-state');
  const run = spawnSync(process.execPath, args, {
    ...options,
    input: requests.map((request, id) => JSON.stringify({ jsonrpc: '2.0', id, ...request })).join('\n') + '\n',
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const responses = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, requests.length);
  return new Map(responses.map(response => [response.id, response]));
}

function writeDecoy(path) {
  mkdirSync(parse(path).dir, { recursive: true });
  writeFileSync(path, 'inert test fixture', { mode: 0o755 });
}

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

test('the bridge reports a missing CLI with a relative host home and PATH', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'agy-relative-home-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const windows = process.platform === 'win32';
  const executable = windows ? 'agy.exe' : 'agy';
  const home = 'relative-home';
  writeDecoy(join(cwd, executable));
  writeDecoy(join(cwd, 'bin', executable));
  writeDecoy(windows
    ? join(cwd, home, 'AppData', 'Local', 'agy', 'bin', executable)
    : join(cwd, home, '.local', 'bin', executable));

  const providerOptions = { acpLaunchSpec: { command: 'agy', args: ['acp'], env: {}, displayName: 'Antigravity CLI' } };
  const maintenance = { providerId: 'antigravity-cli', providerOptions, envVars: { PATH: cwd } };
  const responses = callBridge([
    { method: 'initialize', params: { protocolVersion: 1, client: { name: 'test', version: '1' } } },
    { method: 'thread/start', params: {
      threadId: 'thread', cwd, instructionMode: 'append',
      options: {
        permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user',
        permissionEscalation: 'ask', providerOptions, envVars: { PATH: cwd },
      },
    } },
    { method: 'provider/health', params: maintenance },
    { method: 'provider/usage', params: maintenance },
    { method: 'provider/usage', params: { providerId: 'antigravity-cli' } },
    { method: 'provider/health', params: { providerId: 'antigravity-cli' } },
    { method: 'provider/installation/status', params: maintenance },
    { method: 'provider/installation/run', params: { ...maintenance, action: 'install' } },
  ], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: '', PATH: 'bin' },
  });
  assert.equal(responses.get(0).result.ok, true);
  assert.deepEqual(responses.get(1).error, {
    code: -32000, message: 'Antigravity CLI (agy) was not found on the agent host.',
  });
  assert.equal(providerHealthResultSchema.parse(responses.get(2).result).health.status, 'not_installed');
  assert.deepEqual(responses.get(3).result, { supported: true, usage: { status: 'not_installed' } });
  assert.deepEqual(responses.get(4).result, responses.get(3).result);
  assert.equal(providerHealthResultSchema.parse(responses.get(5).result).health.status, 'unknown');
  assert.equal(providerInstallationStatusSchema.parse(responses.get(6).result).installed, false);
  assert.equal(responses.get(7).result.available, false);
});

test('the bridge skips Windows PATH and LOCALAPPDATA roots without a drive', { skip: process.platform !== 'win32' }, t => {
  const cwd = mkdtempSync(join(tmpdir(), 'agy-drive-less-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'bin');
  const appData = join(cwd, 'appdata');
  writeDecoy(join(bin, 'agy.exe'));
  writeDecoy(join(appData, 'agy', 'bin', 'agy.exe'));
  const params = {
    providerId: 'antigravity-cli',
    providerOptions: { acpLaunchSpec: { command: 'agy', args: ['acp'], env: {}, displayName: 'Antigravity CLI' } },
  };
  const responses = callBridge([
    { method: 'provider/health', params },
    { method: 'provider/usage', params },
    { method: 'provider/usage', params: { providerId: 'antigravity-cli' } },
  ], {
    cwd,
    env: { ...process.env, USERPROFILE: join(cwd, 'host-home'), PATH: bin.slice(2), LOCALAPPDATA: appData.slice(2) },
  });
  assert.equal(providerHealthResultSchema.parse(responses.get(0).result).health.status, 'not_installed');
  assert.deepEqual(responses.get(1).result, { supported: true, usage: { status: 'not_installed' } });
  assert.deepEqual(responses.get(2).result, responses.get(1).result);
});

test('a bare Windows USERPROFILE drive does not prevent ACP launch and usage replies', { skip: process.platform !== 'win32' }, t => {
  const cwd = mkdtempSync(join(tmpdir(), 'agy-home-drive-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeDecoy(join(cwd, 'agy.exe'));
  const providerOptions = { acpLaunchSpec: { command: 'agy', args: ['acp'], env: {}, displayName: 'Antigravity CLI' } };
  const envVars = { PATH: cwd };
  const requests = [
    { method: 'thread/start', params: {
      threadId: 'thread', cwd, instructionMode: 'append',
      options: {
        permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user',
        permissionEscalation: 'ask', providerOptions, envVars,
      },
    } },
    { method: 'provider/usage', params: { providerId: 'antigravity-cli', providerOptions, envVars } },
    { method: 'provider/usage', params: { providerId: 'antigravity-cli', envVars } },
  ];
  for (const appData of ['', join(cwd, 'host-appdata')]) {
    const env = {
      ...process.env,
      BB_ANTIGRAVITY_TASK_STATE_DIR: '',
      PATH: 'bin',
      USERPROFILE: parse(cwd).root.slice(0, 2),
      LOCALAPPDATA: appData,
    };
    const responses = callBridge(requests, { cwd, env, defaultTaskState: true });
    const { error } = responses.get(0);
    if (appData) {
      assert.ok(error?.message.includes(join(appData, 'agy', 'bin', 'agy.exe')), JSON.stringify(error));
    } else {
      assert.deepEqual(error, { code: -32000, message: 'Antigravity CLI (agy) was not found on the agent host.' });
    }
    assert.deepEqual(responses.get(1).result, { supported: true, usage: { status: 'not_installed' } });
    assert.deepEqual(responses.get(2).result, responses.get(1).result);
  }
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
  const requests = cases.map(([version, status], id) => ({
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
  const responses = callBridge(requests);
  for (const [id, [version, status]] of cases.entries()) {
    const { health } = providerHealthResultSchema.parse(responses.get(id).result);
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
