import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const root = process.argv[3];
assert.ok(mode && root, 'Usage: profile-bridge-fixture.mjs <mode> <root>');

const stateDir = join(root, 'state');
const hostBin = join(root, 'host-bin');
const emptyHostBin = join(root, 'empty-host-bin');
const untrustedBin = join(root, 'untrusted-bin');
const defaultHome = join(root, 'default-home');
const alphaGeminiDir = join(root, 'profile-alpha', '.gemini');
const betaGeminiDir = join(root, 'profile-beta-root');
const betaAppDataDir = 'work-app';
const invocationLog = join(root, 'invocations.jsonl');
const untrustedFlag = join(root, 'untrusted-executed.txt');
const sessionsRecordPath = join(root, 'started-sessions.json');

process.env.BB_ANTIGRAVITY_TASK_STATE_DIR = stateDir;
process.env.SYNTHETIC_AGY_LOG = invocationLog;

const { backgroundTaskTracker, experimental_providerBridge: bridge } = await import('../host.ts');

const originalWrite = process.stdout.write.bind(process.stdout);
const messages = [];
let onOutput;
let pending = '';
process.stdout.write = chunk => {
  pending += String(chunk);
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const message = JSON.parse(pending.slice(0, end));
    pending = pending.slice(end + 1);
    messages.push(message);
    onOutput?.(message);
  }
  return true;
};

let nextId = 1;
const send = (method, params) => {
  const id = nextId++;
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return id;
};

const wait = async predicate => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
  }
  throw new Error('Timed out waiting for message: ' + JSON.stringify(messages));
};

function readInvocations() {
  if (!existsSync(invocationLog)) return [];
  return readFileSync(invocationLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function makeLaunchSpec({ pathDir = hostBin, extraHostEnv = {} } = {}) {
  return {
    displayName: 'Antigravity CLI',
    command: 'agy',
    args: ['acp', '--disable-telemetry'],
    env: {
      PATH: pathDir,
      HOME: defaultHome,
      USERPROFILE: defaultHome,
      LOCALAPPDATA: defaultHome,
      SYNTHETIC_AGY_LOG: invocationLog,
      ...extraHostEnv,
    },
  };
}

function makeOptions(envVars, specOptions, enabled = true) {
  return {
    permissionMode: 'accept-edits',
    permissionScope: 'workspace',
    approvalReviewer: 'user',
    permissionEscalation: 'ask',
    ...(envVars !== undefined ? { envVars } : {}),
    providerOptions: {
      ...(enabled === null ? {} : { profileRoutingEnabled: enabled }),
      acpLaunchSpec: makeLaunchSpec(specOptions),
    },
  };
}

function extractTurnPayload(threadId, fromIndex) {
  for (let i = fromIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.method !== 'thread/delta' || msg.params?.threadId !== threadId) continue;
    for (const delta of msg.params.deltas ?? []) {
      const text = delta.text ?? delta.delta ?? delta.item?.text ?? '';
      if (typeof text === 'string' && text.includes('"accountId"')) {
        return JSON.parse(text);
      }
    }
  }
  return null;
}

async function runTurn(threadId, providerThreadId, clientRequestId, envVars, enabled = true) {
  const startIdx = messages.length;
  const reqId = send('turn/start', {
    threadId,
    providerThreadId,
    clientRequestId,
    input: [{ type: 'text', text: 'identify' }],
    options: makeOptions(envVars, undefined, enabled),
  });
  const response = await wait(m => m.id === reqId);
  assert.ok(!response.error, `turn/start failed: ${JSON.stringify(response)}`);
  await wait(() => extractTurnPayload(threadId, startIdx) !== null);
  await wait(() => messages.slice(startIdx).some(m =>
    m.method === 'thread/delta' && m.params.threadId === threadId && m.params.deltas.some(d => d.kind === 'turn.boundary')));
  return extractTurnPayload(threadId, startIdx);
}

async function rejectRoute(method, params) {
  const before = readInvocations().length;
  const id = send(method, params);
  assert.match((await wait(m => m.id === id)).error?.message, /different profile/i);
  assert.equal(readInvocations().length, before, 'profile rejection must happen before invoking agy');
}

async function stopQueuedSteer(threadId, envVars, mode, enabled = true) {
  const opening = send('thread/start', {
    threadId, cwd: root, instructionMode: 'append', options: makeOptions(envVars, undefined, enabled),
  });
  const providerThreadId = (await wait(m => m.id === opening)).result?.providerThreadId;
  assert.match(providerThreadId, enabled ? /^antigravity-profile:/ : /^session-synthetic-default-/);
  const turn = send('turn/start', {
    threadId, providerThreadId, clientRequestId: 'creq_23456789ar',
    input: [{ type: 'text', text: `wait-for-steer-${mode}` }],
    options: makeOptions(envVars, undefined, enabled),
  });
  assert.equal((await wait(m => m.id === turn)).error, undefined);

  const clientRequestId = 'creq_23456789as';
  let stop;
  const sendStop = () => {
    stop = send('thread/stop', { threadId, providerThreadId, intent: 'interrupt', activeTurnId: 'turn-1' });
  };
  if (mode === 'rebuild') {
    // Draining this tool marks the transition into the queued steer before the SDK stops the old process.
    onOutput = m => {
      if (m.method !== 'thread/delta' || m.params.threadId !== threadId ||
          !m.params.deltas.some(d => d.kind === 'item.close' && d.status === 'interrupted')) return;
      onOutput = undefined;
      queueMicrotask(sendStop);
    };
  }
  const steer = send('turn/steer', {
    threadId, providerThreadId, expectedTurnId: 'turn-1', clientRequestId,
    input: [{ type: 'text', text: 'identify' }],
    options: makeOptions({ ...envVars, SYNTHETIC_REBUILD: '1' }, undefined, enabled),
  });
  if (mode !== 'rebuild') sendStop();
  const queued = await wait(m => m.id === steer);
  assert.deepEqual(queued.result, { threadId });
  const stopped = await wait(m => stop !== undefined && m.id === stop);
  assert.equal(stopped.result?.ok, true);
  const settling = messages.slice(messages.indexOf(queued) + 1, messages.indexOf(stopped));
  assert.equal(settling.some(m => m.method === 'thread/delta' && m.params.threadId === threadId &&
    m.params.deltas.some(d => d.kind === 'input.accepted' && d.clientRequestId === clientRequestId)),
  mode === 'rebuild', 'only a steer already in a rebuild may reach ACP before stop is acknowledged');
  assert.ok(!settling.some(m => m.params?.threadId === threadId && ['thread/identity', 'session/replaced'].includes(m.method)));
  assert.ok(readInvocations().some(entry => entry.mode === 'cancel' && entry.promptMode === `wait-for-steer-${mode}`));
  const account = enabled ? 'synthetic-alpha' : 'synthetic-default';
  const finalProcess = readInvocations().findLast(entry => entry.mode === 'acp' && entry.accountId === account);
  assert.throws(() => process.kill(finalProcess.pid, 0), { code: 'ESRCH' }, 'stop must kill the process before acknowledging');
}

const alphaEnv = {
  PATH: untrustedBin,
  LOCALAPPDATA: untrustedBin,
  BB_ANTIGRAVITY_GEMINI_DIR: alphaGeminiDir,
  BB_ANTIGRAVITY_APP_DATA_DIR: 'antigravity-cli',
};

const betaEnv = {
  PATH: untrustedBin,
  LOCALAPPDATA: untrustedBin,
  BB_ANTIGRAVITY_GEMINI_DIR: betaGeminiDir,
  BB_ANTIGRAVITY_APP_DATA_DIR: betaAppDataDir,
};

try {
  const initId = send('initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } });
  assert.ok((await wait(m => m.id === initId)).result);

  if (mode === 'missing-host-agy') {
    const startId = send('thread/start', {
      threadId: 'thread-missing',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions({ PATH: untrustedBin, LOCALAPPDATA: untrustedBin }, { pathDir: emptyHostBin }),
    });
    const startRes = await wait(m => m.id === startId);
    assert.ok(startRes.error, `expected missing host CLI error, got ${JSON.stringify(startRes)}`);
    assert.ok(!startRes.error.message.includes(untrustedBin), `error must not reference session PATH: ${startRes.error.message}`);

    const healthId = send('provider/health', {
      providerId: 'antigravity-cli',
      providerOptions: { acpLaunchSpec: makeLaunchSpec({ pathDir: emptyHostBin }) },
      envVars: { PATH: untrustedBin, LOCALAPPDATA: untrustedBin },
    });
    const healthRes = await wait(m => m.id === healthId);
    assert.equal(healthRes.result?.supported, true);
    assert.equal(healthRes.result?.health?.status, 'not_installed');

    const usageId = send('provider/usage', {
      providerId: 'antigravity-cli',
      providerOptions: { acpLaunchSpec: makeLaunchSpec({ pathDir: emptyHostBin }) },
      envVars: { PATH: untrustedBin, LOCALAPPDATA: untrustedBin },
    });
    const usageRes = await wait(m => m.id === usageId);
    assert.equal(usageRes.result?.supported, true);
    assert.equal(usageRes.result?.usage?.status, 'not_installed');

    assert.equal(existsSync(untrustedFlag), false, 'untrusted session PATH executable must never run');
    assert.deepEqual(readInvocations(), []);
  } else if (mode === 'unresponsive-stop') {
    await stopQueuedSteer('thread-steer-unresponsive', alphaEnv, 'ignore');
    await stopQueuedSteer('thread-default-steer-stop', {}, 'error', false);
  } else if (mode === 'phase1-start') {
    const startAlphaId = send('thread/start', {
      threadId: 'thread-alpha',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(alphaEnv),
    });
    const startedAlpha = await wait(m => m.id === startAlphaId);
    const alphaSessionId = startedAlpha.result?.providerThreadId;
    assert.match(alphaSessionId, /^antigravity-profile:/, JSON.stringify(startedAlpha));
    const alphaTurn1 = await runTurn('thread-alpha', alphaSessionId, 'creq_23456789aa', alphaEnv);
    assert.deepEqual(alphaTurn1, { accountId: 'synthetic-alpha', sessionId: 'session-synthetic-alpha-1', resumed: false });

    const startBetaId = send('thread/start', {
      threadId: 'thread-beta',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(betaEnv),
    });
    const startedBeta = await wait(m => m.id === startBetaId);
    const betaSessionId = startedBeta.result?.providerThreadId;
    assert.match(betaSessionId, /^antigravity-profile:/, JSON.stringify(startedBeta));
    const betaTurn1 = await runTurn('thread-beta', betaSessionId, 'creq_23456789ab', betaEnv);
    assert.deepEqual(betaTurn1, { accountId: 'synthetic-beta', sessionId: 'session-synthetic-beta-1', resumed: false });

    const failedStartId = send('thread/start', {
      threadId: 'thread-default',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions({ BB_ANTIGRAVITY_GEMINI_DIR: join(root, 'uninitialized-profile') }),
    });
    assert.ok((await wait(m => m.id === failedStartId)).error);
    const defaultStartId = send('thread/start', {
      threadId: 'thread-default',
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(alphaEnv, { extraHostEnv: {
        BB_ANTIGRAVITY_GEMINI_DIR: betaGeminiDir,
        BB_ANTIGRAVITY_APP_DATA_DIR: betaAppDataDir,
      } }, null),
    });
    const defaultSessionId = (await wait(m => m.id === defaultStartId)).result?.providerThreadId;
    assert.equal(defaultSessionId, 'session-synthetic-default-1');
    assert.equal((await runTurn('thread-default', defaultSessionId, 'creq_23456789af', alphaEnv, 'true')).accountId, 'synthetic-default');

    // Built-in provider/usage stays host-scoped and ignores routed request envVars
    const routedUsageId = send('provider/usage', {
      providerId: 'antigravity-cli',
      providerOptions: { acpLaunchSpec: makeLaunchSpec() },
      envVars: alphaEnv,
    });
    const routedUsageRes = await wait(m => m.id === routedUsageId);
    assert.equal(routedUsageRes.result?.usage?.status, 'ok');
    assert.deepEqual(
      routedUsageRes.result.usage.windows.map(w => [w.label, w.usedPercent]),
      [['Gemini 7d', 99], ['Claude/GPT 5h', 98]],
    );

    // Quota ignores profile overrides from either source, even with routing enabled.
    const hostProfileUsageId = send('provider/usage', {
      providerId: 'antigravity-cli',
      providerOptions: {
        profileRoutingEnabled: true,
        acpLaunchSpec: makeLaunchSpec({
          extraHostEnv: {
            BB_ANTIGRAVITY_GEMINI_DIR: alphaGeminiDir,
            BB_ANTIGRAVITY_APP_DATA_DIR: 'antigravity-cli',
          },
        }),
      },
    });
    const hostProfileUsageRes = await wait(m => m.id === hostProfileUsageId);
    assert.equal(hostProfileUsageRes.result?.usage?.status, 'ok');
    assert.deepEqual(
      hostProfileUsageRes.result.usage.windows.map(w => [w.label, w.usedPercent]),
      [['Gemini 7d', 99], ['Claude/GPT 5h', 98]],
    );

    assert.equal(existsSync(untrustedFlag), false, 'untrusted session PATH executable must never run');
    writeFileSync(sessionsRecordPath, JSON.stringify({ alphaSessionId, betaSessionId, defaultSessionId }));
  } else if (mode === 'resume-with-corrupt-binding') {
    const { alphaSessionId } = JSON.parse(readFileSync(sessionsRecordPath, 'utf8'));
    const params = {
      threadId: 'thread-alpha', providerThreadId: alphaSessionId, cwd: root, instructionMode: 'append',
      options: makeOptions(alphaEnv),
    };
    await rejectRoute('thread/resume', { ...params, options: makeOptions(betaEnv) });
    const resumed = send('thread/resume', params);
    assert.equal((await wait(m => m.id === resumed)).result?.providerThreadId, alphaSessionId);
    assert.deepEqual(await runTurn('thread-alpha', alphaSessionId, 'creq_23456789at', alphaEnv), {
      accountId: 'synthetic-alpha', sessionId: 'session-synthetic-alpha-1', resumed: true,
    });
  } else if (mode === 'phase2-restart-and-resume') {
    const { alphaSessionId, betaSessionId, defaultSessionId } = JSON.parse(readFileSync(sessionsRecordPath, 'utf8'));
    const alphaResume = {
      threadId: 'thread-alpha', providerThreadId: alphaSessionId, cwd: root, instructionMode: 'append',
      options: makeOptions(alphaEnv),
    };
    await rejectRoute('thread/resume', { ...alphaResume, options: makeOptions(alphaEnv, undefined, false) });
    await rejectRoute('thread/resume', { ...alphaResume, providerThreadId: 'antigravity-profile:1:corrupt' });
    await rejectRoute('thread/resume', { ...alphaResume, threadId: 'another-bb-thread' });
    await rejectRoute('thread/resume', { ...alphaResume, threadId: 'thread-default', providerThreadId: defaultSessionId });

    // 1. Disappeared env contribution after host restart must fail visibly before opening default account
    const missingEnvResumeId = send('thread/resume', {
      threadId: 'thread-alpha',
      providerThreadId: alphaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions({}),
    });
    const missingEnvRes = await wait(m => m.id === missingEnvResumeId);
    assert.ok(missingEnvRes.error, `expected profile mismatch error, got ${JSON.stringify(missingEnvRes)}`);
    assert.match(missingEnvRes.error.message, /different profile/i);
    assert.deepEqual(readInvocations(), [], 'disappeared env resume must not spawn agy');

    // 2. Switching Profile A -> Profile B must fail visibly before opening Profile B
    const wrongProfileResumeId = send('thread/resume', {
      threadId: 'thread-alpha',
      providerThreadId: alphaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(betaEnv),
    });
    const wrongProfileRes = await wait(m => m.id === wrongProfileResumeId);
    assert.ok(wrongProfileRes.error, `expected profile mismatch error, got ${JSON.stringify(wrongProfileRes)}`);
    assert.match(wrongProfileRes.error.message, /different profile/i);
    assert.deepEqual(readInvocations(), [], 'Profile A -> B resume must not spawn agy');

    // 3. Restoring Profile A resumes Thread A cleanly on synthetic-alpha
    const resumeAlphaId = send('thread/resume', {
      threadId: 'thread-alpha',
      providerThreadId: alphaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(alphaEnv),
    });
    const resumedAlpha = await wait(m => m.id === resumeAlphaId);
    assert.equal(resumedAlpha.result?.providerThreadId, alphaSessionId, JSON.stringify(resumedAlpha));
    const alphaTurn2 = await runTurn('thread-alpha', alphaSessionId, 'creq_23456789ac', alphaEnv);
    assert.deepEqual(alphaTurn2, { accountId: 'synthetic-alpha', sessionId: 'session-synthetic-alpha-1', resumed: true });

    // A changed non-profile env var forces the SDK to rebuild from saved launch arguments.
    const rebuildEnv = { ...alphaEnv, SYNTHETIC_REBUILD: '1' };
    const rebuilt = await runTurn('thread-alpha', alphaSessionId, 'creq_23456789ag', rebuildEnv);
    assert.deepEqual(rebuilt, { accountId: 'synthetic-alpha', sessionId: 'session-synthetic-alpha-2', resumed: false });
    const replaced = await wait(m => m.method === 'session/replaced' && m.params.threadId === 'thread-alpha');
    const replacementId = replaced.params.providerThreadId;
    assert.match(replacementId, /^antigravity-profile:/);
    assert.notEqual(replacementId, alphaSessionId);
    assert.equal(replaced.params.contextLost, true);
    const staleTurnId = send('turn/start', {
      ...alphaResume, clientRequestId: 'creq_23456789ak', input: [{ type: 'text', text: 'identify' }],
      options: makeOptions(rebuildEnv),
    });
    assert.match((await wait(m => m.id === staleTurnId)).error?.message, /session was replaced/i);
    assert.deepEqual(await runTurn('thread-alpha', replacementId, 'creq_23456789am', rebuildEnv), rebuilt);

    // 4. Mid-thread turn/start switching Profile A -> Profile B must also fail visibly before opening Profile B
    const invocationsBeforeDrift = readInvocations().length;
    const driftTurnId = send('turn/start', {
      threadId: 'thread-alpha',
      providerThreadId: replacementId,
      clientRequestId: 'creq_23456789ae',
      input: [{ type: 'text', text: 'drift' }],
      options: makeOptions(betaEnv),
    });
    const driftTurnRes = await wait(m => m.id === driftTurnId);
    assert.ok(driftTurnRes.error, `expected profile mismatch error on turn/start, got ${JSON.stringify(driftTurnRes)}`);
    assert.match(driftTurnRes.error.message, /different profile/i);
    assert.equal(readInvocations().length, invocationsBeforeDrift, 'drifted turn/start must not spawn Profile B');

    // The SDK can acknowledge stop while its earlier turn is still replacing the old process.
    const raceStart = messages.length;
    const racingTurnId = send('turn/start', {
      threadId: 'thread-alpha', providerThreadId: replacementId, clientRequestId: 'creq_23456789an',
      input: [{ type: 'text', text: 'identify' }],
      options: makeOptions({ ...rebuildEnv, SYNTHETIC_STOP_RACE: '1' }),
    });
    const stopId = send('thread/stop', {
      threadId: 'thread-alpha', providerThreadId: replacementId, intent: 'release', activeTurnId: null,
    });
    const reopeningId = send('thread/start', {
      threadId: 'thread-alpha', cwd: root, instructionMode: 'append', options: makeOptions(undefined, undefined, false),
    });
    assert.match((await wait(m => m.id === reopeningId)).error?.message, /stopping/i);
    const stopResponse = await wait(m => m.id === stopId);
    assert.equal(stopResponse.result?.ok, true);
    const raced = await wait(m => m.id === racingTurnId);
    assert.ok(messages.indexOf(raced) < messages.indexOf(stopResponse), 'stop must wait for the submitted input and replacement');
    assert.equal(raced.error, undefined, JSON.stringify(raced));
    const lateIdentities = messages.slice(raceStart).filter(m =>
      m.params?.threadId === 'thread-alpha' && ('providerThreadId' in m.params));
    assert.deepEqual(lateIdentities, [], 'the stopped session must not publish its replacement identity');
    const stoppedInvocations = readInvocations();
    const stoppedProcess = stoppedInvocations.findLast(entry => entry.mode === 'acp' && entry.accountId === 'synthetic-alpha');
    assert.throws(() => process.kill(stoppedProcess.pid, 0), { code: 'ESRCH' }, 'stop must release the replacement process');
    const defaultPromptId = send('turn/start', {
      threadId: 'thread-alpha', providerThreadId: 'session-synthetic-alpha-3', clientRequestId: 'creq_23456789ap',
      input: [{ type: 'text', text: 'identify' }], options: makeOptions(undefined, undefined, false),
    });
    assert.match((await wait(m => m.id === defaultPromptId)).error?.message, /no active/i);
    assert.equal(readInvocations().length, stoppedInvocations.length);

    const reopened = send('thread/resume', { ...alphaResume, providerThreadId: replacementId });
    assert.equal((await wait(m => m.id === reopened)).result?.providerThreadId, replacementId);

    // 5. Switching Profile B -> Profile A must fail visibly before opening Profile A
    const invocationsBeforeBetaMismatch = readInvocations().length;
    const betaMismatchId = send('thread/resume', {
      threadId: 'thread-beta',
      providerThreadId: betaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(alphaEnv),
    });
    const betaMismatchRes = await wait(m => m.id === betaMismatchId);
    assert.ok(betaMismatchRes.error, `expected profile mismatch error, got ${JSON.stringify(betaMismatchRes)}`);
    assert.match(betaMismatchRes.error.message, /different profile/i);
    assert.equal(readInvocations().length, invocationsBeforeBetaMismatch, 'Profile B -> A resume must not spawn agy');

    // 6. Restoring Profile B resumes Thread B cleanly on synthetic-beta
    const resumeBetaId = send('thread/resume', {
      threadId: 'thread-beta',
      providerThreadId: betaSessionId,
      cwd: root,
      instructionMode: 'append',
      options: makeOptions(betaEnv),
    });
    const resumedBeta = await wait(m => m.id === resumeBetaId);
    assert.equal(resumedBeta.result?.providerThreadId, betaSessionId, JSON.stringify(resumedBeta));
    const betaTurn2 = await runTurn('thread-beta', betaSessionId, 'creq_23456789ad', betaEnv);
    assert.deepEqual(betaTurn2, { accountId: 'synthetic-beta', sessionId: 'session-synthetic-beta-1', resumed: true });

    const defaultResumeId = send('thread/resume', {
      ...alphaResume, threadId: 'thread-default', providerThreadId: defaultSessionId, options: makeOptions({}),
    });
    assert.equal((await wait(m => m.id === defaultResumeId)).result?.providerThreadId, defaultSessionId);
    const rebuiltDefault = await runTurn('thread-default', defaultSessionId, 'creq_23456789aq', { SYNTHETIC_REBUILD: '1' }, false);
    assert.deepEqual(rebuiltDefault, { accountId: 'synthetic-default', sessionId: 'session-synthetic-default-2', resumed: false });
    const defaultReplacement = await wait(m => m.method === 'session/replaced' && m.params.threadId === 'thread-default');
    assert.equal(defaultReplacement.params.providerThreadId, rebuiltDefault.sessionId);

    await stopQueuedSteer('thread-steer-rebuild', alphaEnv, 'rebuild');
    await stopQueuedSteer('thread-steer-error', alphaEnv, 'error');

    const turn = {
      threadId: 'thread-beta', providerThreadId: betaSessionId, clientRequestId: 'creq_23456789ah',
      input: [{ type: 'text', text: 'hold' }], options: makeOptions(betaEnv),
    };
    send('turn/start', turn);
    await wait(() => backgroundTaskTracker.isHoldingTurn('thread-beta'));
    const steer = { ...turn, expectedTurnId: 'turn-1', clientRequestId: 'creq_23456789aj', input: [{ type: 'text', text: 'continue' }] };
    await rejectRoute('turn/steer', { ...steer, options: makeOptions(alphaEnv) });
    await rejectRoute('turn/steer', { ...steer, options: makeOptions(betaEnv, undefined, false) });
    assert.equal(backgroundTaskTracker.isHoldingTurn('thread-beta'), true);

    const continuationStart = messages.length;
    const steerId = send('turn/steer', steer);
    assert.equal((await wait(m => m.id === steerId)).error, undefined);
    await wait(() => extractTurnPayload('thread-beta', continuationStart));
    assert.equal(extractTurnPayload('thread-beta', continuationStart).accountId, 'synthetic-beta');

    assert.equal(existsSync(untrustedFlag), false, 'untrusted session PATH executable must never run');
  } else {
    throw new Error(`Unknown fixture mode: ${mode}`);
  }

  bridge.onClose?.();
  originalWrite('verified\n');
} catch (error) {
  process.stderr.write(String(error?.stack || error) + '\n');
  bridge.onClose?.();
  process.exitCode = 1;
}
