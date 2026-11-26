import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBucketWindowLabel,
  normalizeAntigravityUsageOutput,
  readAntigravityProviderUsage,
  registerAntigravityUsageSource,
} from '../usage.ts';
import { experimental_providerBridge } from './isolated-host.mjs';
import { providerUsageResultSchema } from '@get-bb/plugin-sdk/provider-bridge';

const SAMPLE_USAGE_JSON = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  response: '',
  command: {
    name: 'usage',
    data: {
      description: 'Within each group, models share a weekly limit and a 5-hour limit.',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.9584503769874573,
              reset_time: '2026-11-11T18:50:51Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.9029293060302734,
              reset_time: '2026-11-05T15:30:15Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.16722920536994934,
              reset_time: '2026-11-11T22:11:24Z',
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.4976448118686676,
              reset_time: '2026-11-05T16:20:13Z',
            },
          ],
        },
        {
          name: 'Gemini 4 Argon',
          description: 'For paid Pro plans, Argon quota is separate.',
          buckets: [
            {
              id: 'gemini-argon-wtu-weekly',
              name: 'Gemini 4 Argon Weekly Limit',
              window: 'weekly',
              remaining_fraction: 0.6540166735649109,
              reset_time: '2026-11-11T20:39:54Z',
            },
          ],
        },
      ],
    },
  },
});

test('normalizes Antigravity per-model quota groups into BB usage windows', () => {
  const result = normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON);
  const parsed = providerUsageResultSchema.parse(result);
  assert.equal(parsed.supported, true);
  assert.equal(parsed.usage.status, 'ok');
  assert.deepEqual(parsed.usage.windows, [
    {
      label: 'Gemini 7d',
      usedPercent: 4,
      resetsAt: '2026-11-11T18:50:51.000Z',
      kind: 'custom',
      model: null,
    },
    {
      label: 'Gemini 5h',
      usedPercent: 10,
      resetsAt: '2026-11-05T15:30:15.000Z',
      kind: 'custom',
      model: null,
    },
    {
      label: 'Claude/GPT 7d',
      usedPercent: 83,
      resetsAt: '2026-11-11T22:11:24.000Z',
      kind: 'custom',
      model: null,
    },
    {
      label: 'Claude/GPT 5h',
      usedPercent: 50,
      resetsAt: '2026-11-05T16:20:13.000Z',
      kind: 'custom',
      model: null,
    },
    {
      label: 'Argon 7d',
      usedPercent: 35,
      resetsAt: '2026-11-11T20:39:54.000Z',
      kind: 'custom',
      model: null,
    },
  ]);
});

test('formats bucket window labels concisely', () => {
  assert.equal(formatBucketWindowLabel('Gemini Models', { name: 'Weekly Limit Remaining', window: 'weekly' }), 'Gemini 7d');
  assert.equal(formatBucketWindowLabel('Claude and GPT models', { name: 'Five Hour Limit Remaining', window: '5h' }), 'Claude/GPT 5h');
  assert.equal(formatBucketWindowLabel('Gemini 4 Argon', { name: 'Gemini 4 Argon Weekly Limit', window: 'weekly' }), 'Argon 7d');
  assert.equal(formatBucketWindowLabel(null, { name: 'Daily Limit', window: 'daily' }), '1d');
});

test('skips disabled buckets and treats omitted remaining_fraction on active buckets as 100% used', () => {
  const json = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Claude and GPT models',
            buckets: [
              {
                id: '3p-weekly',
                name: 'Weekly Limit Remaining',
                window: 'weekly',
                reset_time: '2026-11-11T22:11:24Z',
              },
              {
                id: '3p-5h',
                name: 'Five Hour Limit Remaining',
                window: '5h',
                disabled: true,
                remaining_fraction: 0.14,
              },
            ],
          },
        ],
      },
    },
  });
  const result = normalizeAntigravityUsageOutput(json);
  assert.equal(result.usage.status, 'ok');
  assert.deepEqual(result.usage.windows, [
    {
      label: 'Claude/GPT 7d',
      usedPercent: 100,
      resetsAt: '2026-11-11T22:11:24.000Z',
      kind: 'custom',
      model: null,
    },
  ]);
});

test('handles missing executable, unauthenticated, expired, and malformed usage responses', async () => {
  const notInstalled = await readAntigravityProviderUsage({
    resolveCommand: () => null,
  });
  assert.deepEqual(notInstalled, { supported: true, usage: { status: 'not_installed' } });

  const unauth = await readAntigravityProviderUsage({
    resolveCommand: () => '/usr/bin/agy',
    execFile: async () => {
      throw Object.assign(new Error('You are currently not signed in.'), { stdout: '', stderr: '' });
    },
  });
  assert.deepEqual(unauth, { supported: true, usage: { status: 'unauthenticated' } });

  const expired = await readAntigravityProviderUsage({
    resolveCommand: () => '/usr/bin/agy',
    execFile: async () => {
      throw Object.assign(new Error('OAuth session expired: invalid_grant'), { stdout: '', stderr: '' });
    },
  });
  assert.deepEqual(expired, { supported: true, usage: { status: 'expired' } });

  const malformed = normalizeAntigravityUsageOutput('not json');
  assert.equal(malformed.supported, true);
  assert.equal(malformed.usage.status, 'error');
});

test('recognizes authentication failures in usage output', () => {
  assert.equal(normalizeAntigravityUsageOutput('Not signed in').usage.status, 'unauthenticated');
  assert.equal(normalizeAntigravityUsageOutput(JSON.stringify({ status: 'ERROR', error: 'token expired' })).usage.status, 'expired');
});

test('returns error when command resolution throws', async () => {
  const result = await readAntigravityProviderUsage({
    resolveCommand: () => { throw new Error('resolution failed'); },
  });
  assert.equal(result.usage.status, 'error');
});

test('responds to provider/usage JSON-RPC requests', async () => {
  const originalWrite = process.stdout.write;
  try {
    experimental_providerBridge.start();
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No usage response')), 5000);
      process.stdout.write = chunk => {
        clearTimeout(timer);
        resolve(String(chunk));
        return true;
      };
      experimental_providerBridge.handleLine(JSON.stringify({
        jsonrpc: '2.0', id: 42, method: 'provider/usage',
        params: { providerOptions: { acpLaunchSpec: { displayName: 'Missing', command: 'missing-antigravity-test-command', args: [], env: {} } } },
      }));
    });
    const parsed = JSON.parse(await response);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, 42);
    assert.deepEqual(providerUsageResultSchema.parse(parsed.result), { supported: true, usage: { status: 'not_installed' } });
  } finally {
    process.stdout.write = originalWrite;
  }
});

test('registers discoverable provider-usage.v1 RPC handlers and returns host usage', async () => {
  let registeredContract;
  let registeredHandlers;
  let registeredOptions;

  const mockBb = {
    pluginId: 'antigravity-cli',
    rpc: {
      register(contract, handlers, options) {
        registeredContract = contract;
        registeredHandlers = handlers;
        registeredOptions = options;
      },
    },
    sdk: {
      hosts: {
        list: async () => [{ id: 'host_1', name: 'Primary Machine', status: 'connected' }],
        get: async ({ hostId }) => ({ id: hostId, name: 'Primary Machine', status: 'connected' }),
      },
      providers: {
        list: async () => [
          {
            id: 'antigravity-cli',
            pluginId: 'antigravity-cli',
            displayName: 'Antigravity CLI',
          },
        ],
      },
      system: {
        usageLimits: async () => ({
          'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage,
        }),
      },
    },
  };

  registerAntigravityUsageSource(mockBb);
  assert.ok(registeredContract);
  assert.equal(registeredOptions?.experimental_discoverable, true);

  const listResult = await registeredHandlers['provider-usage.v1.listResources']({});
  assert.equal(listResult.resources.length, 1);
  assert.equal(listResult.resources[0].providerId, 'antigravity-cli');
  assert.equal(listResult.resources[0].scope.kind, 'host');

  const getResult = await registeredHandlers['provider-usage.v1.getResource']({
    resourceId: listResult.resources[0].id,
    refresh: true,
  });
  assert.equal(getResult.usage.status, 'ok');
  assert.equal(getResult.usage.windows.length, 5);
  assert.equal(getResult.usage.windows[0].label, 'Gemini 7d');
});

test('evicts cached usage when the provider is removed', async () => {
  let handlers;
  let enabled = true;
  let collections = 0;
  const bb = {
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: { get: async () => ({ id: 'host_1', name: 'Machine', status: 'connected' }) },
      providers: { list: async () => enabled ? [{ id: 'antigravity-cli', pluginId: 'antigravity-cli' }] : [] },
      system: { usageLimits: async () => {
        collections++;
        return { 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage };
      } },
    },
  };
  registerAntigravityUsageSource(bb);
  const getResource = handlers['provider-usage.v1.getResource'];
  const resourceId = JSON.stringify(['host_1', 'antigravity-cli']);
  assert.equal((await getResource({ resourceId, refresh: true })).usage.status, 'ok');
  enabled = false;
  await assert.rejects(getResource({ resourceId, refresh: true }), /no longer exists/);
  enabled = true;
  await getResource({ resourceId, refresh: false });
  assert.equal(collections, 2);
});

test('does not invent a resource on first-ever failed host lookup, recovers on retry, and keeps remembered host visible', async () => {
  let handlers;
  let host2Failing = true;
  const collections = new Map();
  const hosts = [
    { id: 'host_1', name: 'Primary Machine', status: 'connected' },
    { id: 'host_2', name: 'Remote Machine', status: 'connected' },
  ];

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => hosts,
        get: async ({ hostId }) => hosts.find(h => h.id === hostId),
      },
      providers: {
        list: async ({ hostId }) => {
          if (hostId === 'host_2' && host2Failing) {
            throw new Error('Remote host lookup timed out');
          }
          return [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI (Remote)' }];
        },
      },
      system: {
        usageLimits: async ({ hostId }) => {
          collections.set(hostId, (collections.get(hostId) ?? 0) + 1);
          return { 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage };
        },
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host2Id = JSON.stringify(['host_2', 'antigravity-cli']);

  // Fresh host whose first-ever provider lookup fails must not invent a resource.
  const firstList = await listResources({});
  assert.equal(firstList.resources.length, 1);
  assert.equal(firstList.resources[0].scope.hostId, 'host_1');

  const healthyUsage = await getResource({ resourceId: firstList.resources[0].id, refresh: true });
  assert.equal(healthyUsage.usage.status, 'ok');
  assert.equal(healthyUsage.usage.windows.length, 5);

  // Direct getResource on an unconfirmed failing host reports error without remembering it.
  const failedUsage = await getResource({ resourceId: host2Id, refresh: true });
  assert.equal(failedUsage.usage.status, 'error');
  assert.equal(failedUsage.observedAt, null);
  const stillUnconfirmedList = await listResources({});
  assert.equal(stillUnconfirmedList.resources.length, 1);

  // Once the fresh host succeeds, it appears in inventory and is remembered.
  host2Failing = false;
  const recoveredList = await listResources({});
  assert.equal(recoveredList.resources.length, 2);
  assert.equal(recoveredList.resources[1].label, 'Antigravity CLI (Remote)');

  const recoveredUsage = await getResource({ resourceId: recoveredList.resources[1].id, refresh: true });
  assert.equal(recoveredUsage.usage.status, 'ok');
  assert.equal(recoveredUsage.usage.windows.length, 5);
  assert.equal(collections.get('host_1'), 1);
  assert.equal(collections.get('host_2'), 1);

  // Subsequent transient failure on the remembered host preserves its inventory entry and label.
  host2Failing = true;
  const rememberedList = await listResources({});
  assert.equal(rememberedList.resources.length, 2);
  assert.equal(rememberedList.resources[1].scope.hostId, 'host_2');
  assert.equal(rememberedList.resources[1].label, 'Antigravity CLI (Remote)');
});

test('preserves cached observations across transient host lookup failures and evicts only on confirmed removal', async () => {
  let handlers;
  let host2LookupFails = false;
  let host2GetError = null;
  let host2Enabled = true;
  let host2Present = true;
  const collections = new Map();
  const makeHosts = () => [
    { id: 'host_1', name: 'Primary Machine', status: 'connected' },
    ...(host2Present ? [{ id: 'host_2', name: 'Remote Machine', status: 'connected' }] : []),
  ];

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => makeHosts(),
        get: async ({ hostId }) => {
          if (hostId === 'host_2' && host2GetError) {
            throw host2GetError;
          }
          const found = makeHosts().find(h => h.id === hostId);
          if (!found) {
            throw Object.assign(new Error('Host not found'), { status: 404 });
          }
          return found;
        },
      },
      providers: {
        list: async ({ hostId }) => {
          if (hostId === 'host_2' && host2LookupFails) {
            throw new Error('Transient RPC failure');
          }
          if (hostId === 'host_2' && !host2Enabled) {
            return [];
          }
          return [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }];
        },
      },
      system: {
        usageLimits: async ({ hostId }) => {
          collections.set(hostId, (collections.get(hostId) ?? 0) + 1);
          return { 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage };
        },
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host1Id = JSON.stringify(['host_1', 'antigravity-cli']);
  const host2Id = JSON.stringify(['host_2', 'antigravity-cli']);

  await listResources({});
  const initialHost1 = await getResource({ resourceId: host1Id, refresh: true });
  const initialHost2 = await getResource({ resourceId: host2Id, refresh: true });
  assert.equal(initialHost1.usage.status, 'ok');
  assert.equal(initialHost2.usage.status, 'ok');
  assert.ok(initialHost2.observedAt !== null);

  // Transient inventory failure on host_2 keeps host_1 healthy and preserves host_2 cache.
  host2LookupFails = true;
  const listDuringFailure = await listResources({});
  assert.deepEqual(listDuringFailure.resources.map(r => r.id), [host1Id, host2Id]);
  const host1DuringFailure = await getResource({ resourceId: host1Id, refresh: false });
  assert.equal(host1DuringFailure.usage.status, 'ok');
  assert.equal(collections.get('host_1'), 1);

  const host2DuringFailure = await getResource({ resourceId: host2Id, refresh: true });
  assert.equal(host2DuringFailure.usage.status, 'error');
  assert.equal(host2DuringFailure.observedAt, initialHost2.observedAt);

  // Transient non-404 hosts.get error also preserves cached observation.
  host2LookupFails = false;
  host2GetError = Object.assign(new Error('Gateway unavailable'), { status: 503 });
  const host2TransientGetError = await getResource({ resourceId: host2Id, refresh: true });
  assert.equal(host2TransientGetError.usage.status, 'error');
  assert.equal(host2TransientGetError.observedAt, initialHost2.observedAt);

  // Recovery serves preserved cached observation when refresh is false.
  host2GetError = null;
  const host2RecoveredCached = await getResource({ resourceId: host2Id, refresh: false });
  assert.equal(host2RecoveredCached.usage.status, 'ok');
  assert.equal(host2RecoveredCached.observedAt, initialHost2.observedAt);
  assert.equal(collections.get('host_2'), 1);

  // Confirmed provider removal on host_2 evicts cache and drops host_2 from inventory.
  host2Enabled = false;
  const listAfterProviderRemoved = await listResources({});
  assert.deepEqual(listAfterProviderRemoved.resources.map(r => r.id), [host1Id]);
  await assert.rejects(getResource({ resourceId: host2Id, refresh: false }), /no longer exists/);

  // Re-enabling requires a fresh collection because confirmed removal evicted cache.
  host2Enabled = true;
  await listResources({});
  await getResource({ resourceId: host2Id, refresh: false });
  assert.equal(collections.get('host_2'), 2);

  // Confirmed host removal from hosts.list() also evicts cache.
  host2Present = false;
  const listAfterHostRemoved = await listResources({});
  assert.deepEqual(listAfterHostRemoved.resources.map(r => r.id), [host1Id]);
  await assert.rejects(getResource({ resourceId: host2Id, refresh: false }), /no longer exists/);
  host2Present = true;
  await listResources({});
  await getResource({ resourceId: host2Id, refresh: false });
  assert.equal(collections.get('host_2'), 3);
});

test('slow getResource does not overwrite a confirmed deletion', async () => {
  let handlers;
  let enabled = true;
  let releaseLimits;
  const limitsStarted = new Promise(resolve => {
    releaseLimits = resolve;
  });
  let finishLimits;
  const limitsGate = new Promise(resolve => {
    finishLimits = resolve;
  });

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [{ id: 'host_1', name: 'Primary Machine', status: 'connected' }],
        get: async ({ hostId }) => ({ id: hostId, name: 'Primary Machine', status: 'connected' }),
      },
      providers: {
        list: async () => enabled ? [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }] : [],
      },
      system: {
        usageLimits: async () => {
          releaseLimits();
          await limitsGate;
          return { 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage };
        },
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host1Id = JSON.stringify(['host_1', 'antigravity-cli']);

  const slowGet = getResource({ resourceId: host1Id, refresh: true });
  await limitsStarted;

  enabled = false;
  const afterDelete = await listResources({});
  assert.deepEqual(afterDelete.resources, []);

  finishLimits();
  await assert.rejects(slowGet, /no longer exists/);

  await assert.rejects(getResource({ resourceId: host1Id, refresh: false }), /no longer exists/);
});

test('older inventory snapshot does not evict a newer confirmed resource', async () => {
  let handlers;
  let releaseSlowSnapshot;
  const slowSnapshotStarted = new Promise(resolve => {
    releaseSlowSnapshot = resolve;
  });
  let finishSlowSnapshot;
  const slowSnapshotGate = new Promise(resolve => {
    finishSlowSnapshot = resolve;
  });
  let host2Present = false;
  let hostsListCalls = 0;

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => {
          hostsListCalls++;
          if (hostsListCalls === 1) {
            releaseSlowSnapshot();
            await slowSnapshotGate;
            return [{ id: 'host_1', name: 'Primary Machine', status: 'connected' }];
          }
          return [
            { id: 'host_1', name: 'Primary Machine', status: 'connected' },
            ...(host2Present ? [{ id: 'host_2', name: 'Remote Machine', status: 'connected' }] : []),
          ];
        },
        get: async ({ hostId }) => ({
          id: hostId,
          name: hostId === 'host_1' ? 'Primary Machine' : 'Remote Machine',
          status: 'connected',
        }),
      },
      providers: {
        list: async () => [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }],
      },
      system: {
        usageLimits: async () => ({ 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage }),
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host2Id = JSON.stringify(['host_2', 'antigravity-cli']);

  const olderList = listResources({});
  await slowSnapshotStarted;

  host2Present = true;
  const newerList = await listResources({});
  assert.deepEqual(newerList.resources.map(r => r.scope.hostId), ['host_1', 'host_2']);
  const host2Usage = await getResource({ resourceId: host2Id, refresh: true });
  assert.equal(host2Usage.usage.status, 'ok');

  finishSlowSnapshot();
  await olderList;

  const afterOlderList = await listResources({});
  assert.deepEqual(afterOlderList.resources.map(r => r.scope.hostId), ['host_1', 'host_2']);
  const host2Cached = await getResource({ resourceId: host2Id, refresh: false });
  assert.equal(host2Cached.usage.status, 'ok');
  assert.equal(host2Cached.observedAt, host2Usage.observedAt);
});

test('disconnected host retains only its known resources without querying providers', async () => {
  let handlers;
  let host1Status = 'connected';
  let host2Status = 'disconnected';
  const providerListHosts = [];

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [
          { id: 'host_1', name: 'Primary Machine', status: host1Status },
          { id: 'host_2', name: 'Remote Machine', status: host2Status },
        ],
        get: async ({ hostId }) => ({
          id: hostId,
          name: hostId === 'host_1' ? 'Primary Machine' : 'Remote Machine',
          status: hostId === 'host_1' ? host1Status : host2Status,
        }),
      },
      providers: {
        list: async ({ hostId }) => {
          providerListHosts.push(hostId);
          return [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }];
        },
      },
      system: {
        usageLimits: async () => ({ 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage }),
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host1Id = JSON.stringify(['host_1', 'antigravity-cli']);

  // Confirm host_1 while connected; host_2 is disconnected and unknown.
  const initialList = await listResources({});
  assert.deepEqual(initialList.resources.map(r => r.scope.hostId), ['host_1']);
  assert.deepEqual(providerListHosts, ['host_1']);

  const host1Initial = await getResource({ resourceId: host1Id, refresh: true });
  assert.equal(host1Initial.usage.status, 'ok');

  // When host_1 disconnects, it stays visible and providers.list is not called for either disconnected host.
  host1Status = 'disconnected';
  providerListHosts.length = 0;
  const disconnectedList = await listResources({});
  assert.deepEqual(disconnectedList.resources.map(r => r.scope.hostId), ['host_1']);
  assert.deepEqual(providerListHosts, []);

  // Reconnecting serves preserved cache on refresh: false.
  host1Status = 'connected';
  const host1Reconnected = await getResource({ resourceId: host1Id, refresh: false });
  assert.equal(host1Reconnected.usage.status, 'ok');
  assert.equal(host1Reconnected.observedAt, host1Initial.observedAt);
});

test('older first discovery cannot revive an absent host', async () => {
  let handlers;
  let releaseOldProvider;
  const oldProviderStarted = new Promise(resolve => {
    releaseOldProvider = resolve;
  });
  let finishOldProvider;
  const oldProviderGate = new Promise(resolve => {
    finishOldProvider = resolve;
  });
  let host2Present = true;
  let listCalls = 0;

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [
          { id: 'host_1', name: 'Primary Machine', status: 'connected' },
          ...(host2Present ? [{ id: 'host_2', name: 'Remote Machine', status: 'connected' }] : []),
        ],
        get: async ({ hostId }) => {
          if (hostId === 'host_2' && !host2Present) {
            throw Object.assign(new Error('Host not found'), { status: 404 });
          }
          return { id: hostId, name: hostId, status: 'connected' };
        },
      },
      providers: {
        list: async ({ hostId }) => {
          if (hostId === 'host_2') {
            listCalls++;
            if (listCalls === 1) {
              releaseOldProvider();
              await oldProviderGate;
            }
          }
          return [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }];
        },
      },
      system: {
        usageLimits: async () => ({ 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage }),
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host2Id = JSON.stringify(['host_2', 'antigravity-cli']);

  const olderDiscovery = listResources({});
  await oldProviderStarted;

  host2Present = false;
  const newerList = await listResources({});
  assert.deepEqual(newerList.resources.map(r => r.scope.hostId), ['host_1']);

  finishOldProvider();
  const olderResult = await olderDiscovery;
  assert.deepEqual(olderResult.resources.map(r => r.scope.hostId), ['host_1']);

  await assert.rejects(getResource({ resourceId: host2Id, refresh: false }), /no longer exists/);
});

test('getResource after deletion and re-add does not join invalidated in-flight work', async () => {
  let handlers;
  let enabled = true;
  let usageCall = 0;
  let releaseSlowGet;
  const slowGetStarted = new Promise(resolve => {
    releaseSlowGet = resolve;
  });
  let finishSlowGet;
  const slowGetGate = new Promise(resolve => {
    finishSlowGet = resolve;
  });

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [{ id: 'host_1', name: 'Primary Machine', status: 'connected' }],
        get: async ({ hostId }) => ({ id: hostId, name: 'Primary Machine', status: 'connected' }),
      },
      providers: {
        list: async () => enabled ? [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }] : [],
      },
      system: {
        usageLimits: async () => {
          usageCall++;
          if (usageCall === 1) {
            releaseSlowGet();
            await slowGetGate;
          }
          return { 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage };
        },
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host1Id = JSON.stringify(['host_1', 'antigravity-cli']);

  const firstGet = getResource({ resourceId: host1Id, refresh: true });
  await slowGetStarted;

  enabled = false;
  await listResources({});
  enabled = true;
  await listResources({});

  const secondGet = await getResource({ resourceId: host1Id, refresh: true });
  assert.equal(secondGet.usage.status, 'ok');
  assert.equal(usageCall, 2);

  finishSlowGet();
  await assert.rejects(firstGet, /no longer exists/);
});

test('older listResources eviction does not poison newer in-flight listResources or getResource', async () => {
  let handlers;
  let enabled = false;
  let callIndex = 0;
  let releaseOlder;
  const olderStarted = new Promise(resolve => {
    releaseOlder = resolve;
  });
  let finishOlder;
  const olderGate = new Promise(resolve => {
    finishOlder = resolve;
  });
  let releaseNewer;
  let newerStartedCount = 0;
  const newerStarted = new Promise(resolve => {
    releaseNewer = resolve;
  });
  let finishNewer;
  const newerGate = new Promise(resolve => {
    finishNewer = resolve;
  });

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [{ id: 'host_1', name: 'Primary Machine', status: 'connected' }],
        get: async ({ hostId }) => ({ id: hostId, name: 'Primary Machine', status: 'connected' }),
      },
      providers: {
        list: async () => {
          callIndex++;
          if (callIndex === 1) {
            releaseOlder();
            await olderGate;
            return [];
          }
          newerStartedCount++;
          if (newerStartedCount === 2) releaseNewer();
          await newerGate;
          return enabled ? [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }] : [];
        },
      },
      system: {
        usageLimits: async () => ({ 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage }),
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host1Id = JSON.stringify(['host_1', 'antigravity-cli']);

  const olderList = listResources({});
  await olderStarted;

  enabled = true;
  const newerList = listResources({});
  const newerGet = getResource({ resourceId: host1Id, refresh: true });
  await newerStarted;

  finishOlder();
  const olderResult = await olderList;
  assert.deepEqual(olderResult.resources, []);

  finishNewer();
  const [newerListResult, newerGetResult] = await Promise.all([newerList, newerGet]);
  assert.deepEqual(newerListResult.resources.map(r => r.scope.hostId), ['host_1']);
  assert.equal(newerGetResult.usage.status, 'ok');
});

test('stale getResource empty providers.list does not evict a resource confirmed by newer listResources', async () => {
  let handlers;
  let enabled = false;
  let host1Status = 'connected';
  let providerCalls = 0;
  let releaseOldGet;
  const oldGetStarted = new Promise(resolve => {
    releaseOldGet = resolve;
  });
  let finishOldGet;
  const oldGetGate = new Promise(resolve => {
    finishOldGet = resolve;
  });

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [{ id: 'host_1', name: 'Primary Machine', status: host1Status }],
        get: async ({ hostId }) => ({ id: hostId, name: 'Primary Machine', status: host1Status }),
      },
      providers: {
        list: async () => {
          providerCalls++;
          if (providerCalls === 1) {
            releaseOldGet();
            await oldGetGate;
            return [];
          }
          return enabled ? [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }] : [];
        },
      },
      system: {
        usageLimits: async () => ({ 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage }),
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host1Id = JSON.stringify(['host_1', 'antigravity-cli']);

  const oldGet = getResource({ resourceId: host1Id, refresh: true });
  await oldGetStarted;

  enabled = true;
  const newerList = await listResources({});
  assert.deepEqual(newerList.resources.map(r => r.scope.hostId), ['host_1']);

  // A getResource issued after newerList must not join the superseded oldGet.
  const freshGet = await getResource({ resourceId: host1Id, refresh: true });
  assert.equal(freshGet.usage.status, 'ok');

  finishOldGet();
  await assert.rejects(oldGet, /no longer exists/);

  host1Status = 'disconnected';
  const disconnectedList = await listResources({});
  assert.deepEqual(disconnectedList.resources.map(r => r.scope.hostId), ['host_1']);
});

test('evicted getResource rejects instead of returning stale observedAt on provider lookup error', async () => {
  let handlers;
  let enabled = true;
  let failNextProviderLookup = false;
  let releaseSlowGet;
  const slowGetStarted = new Promise(resolve => {
    releaseSlowGet = resolve;
  });
  let finishSlowGet;
  const slowGetGate = new Promise(resolve => {
    finishSlowGet = resolve;
  });

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [{ id: 'host_1', name: 'Primary Machine', status: 'connected' }],
        get: async ({ hostId }) => ({ id: hostId, name: 'Primary Machine', status: 'connected' }),
      },
      providers: {
        list: async () => {
          if (failNextProviderLookup) {
            failNextProviderLookup = false;
            releaseSlowGet();
            await slowGetGate;
            throw new Error('Transient RPC failure');
          }
          return enabled ? [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Antigravity CLI' }] : [];
        },
      },
      system: {
        usageLimits: async () => ({ 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage }),
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];
  const getResource = handlers['provider-usage.v1.getResource'];
  const host1Id = JSON.stringify(['host_1', 'antigravity-cli']);

  const initial = await getResource({ resourceId: host1Id, refresh: true });
  assert.equal(initial.usage.status, 'ok');
  assert.ok(initial.observedAt !== null);

  failNextProviderLookup = true;
  const slowGet = getResource({ resourceId: host1Id, refresh: true });
  await slowGetStarted;

  enabled = false;
  await listResources({});

  finishSlowGet();
  await assert.rejects(slowGet, /no longer exists/);
});

test('older listResources does not overwrite newer knownResources label', async () => {
  let handlers;
  let host1Status = 'connected';
  let displayName = 'Old Label';
  let providerCalls = 0;
  let releaseOlder;
  const olderStarted = new Promise(resolve => {
    releaseOlder = resolve;
  });
  let finishOlder;
  const olderGate = new Promise(resolve => {
    finishOlder = resolve;
  });

  registerAntigravityUsageSource({
    pluginId: 'antigravity-cli',
    rpc: { register(_contract, registered) { handlers = registered; } },
    sdk: {
      hosts: {
        list: async () => [{ id: 'host_1', name: 'Primary Machine', status: host1Status }],
      },
      providers: {
        list: async () => {
          providerCalls++;
          if (providerCalls === 1) {
            releaseOlder();
            await olderGate;
            return [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName: 'Old Label' }];
          }
          return [{ id: 'antigravity-cli', pluginId: 'antigravity-cli', displayName }];
        },
      },
      system: {
        usageLimits: async () => ({ 'antigravity-cli': normalizeAntigravityUsageOutput(SAMPLE_USAGE_JSON).usage }),
      },
    },
  });

  const listResources = handlers['provider-usage.v1.listResources'];

  const olderList = listResources({});
  await olderStarted;

  displayName = 'New Label';
  const newerList = await listResources({});
  assert.equal(newerList.resources[0].label, 'New Label');

  finishOlder();
  await olderList;

  host1Status = 'disconnected';
  const disconnectedList = await listResources({});
  assert.equal(disconnectedList.resources[0].label, 'New Label');
});
