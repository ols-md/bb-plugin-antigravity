import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../server.ts';
import { experimental_acpLaunchSpecSchema } from '@get-bb/plugin-sdk/provider-bridge/acp';

test('registers a native ACP provider without changing credentials or bypassing approvals', () => {
  const declarations = [];
  plugin({ providers: { register(value) { declarations.push(value); } } });
  assert.equal(declarations.length, 1);
  const provider = declarations[0];
  const spec = experimental_acpLaunchSpecSchema.parse(provider.experimental_bridgeOptions.acpLaunchSpec);
  assert.equal(spec.command, 'agy');
  assert.deepEqual(spec.args, ['acp', '--disable-telemetry']);
  assert.deepEqual(spec.env, {});
  assert.equal(spec.cwd, undefined);
  assert.equal(spec.permissionCli, undefined);
  assert.deepEqual(provider.capabilities.permissionModes, ['accept-edits']);
  assert.equal(provider.experimental_bridgeOptions.acpDialect, 'acp');
});
