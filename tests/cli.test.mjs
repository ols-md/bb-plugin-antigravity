import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
