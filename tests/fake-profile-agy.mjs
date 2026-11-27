import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const baseHome = (process.platform === 'win32' ? process.env.USERPROFILE || process.env.HOME : process.env.HOME) || homedir();
const invocationLog = process.env.SYNTHETIC_AGY_LOG;

function logInvocation(entry) {
  if (!invocationLog) return;
  appendFileSync(invocationLog, JSON.stringify(entry) + '\n');
}

function readFlag(list, names) {
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    for (const name of names) {
      if (arg === name) return list[i + 1] ?? null;
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return null;
}

function readSyntheticAccount(appDataDir) {
  const accountPath = join(appDataDir, 'synthetic-account.json');
  if (!existsSync(accountPath)) return null;
  return JSON.parse(readFileSync(accountPath, 'utf8'));
}

if (args[0] === '-p' && args[1] === '/usage') {
  if (args.some(arg => arg.startsWith('--gemini-dir') || arg.startsWith('--gemini_dir') || arg.startsWith('--app-data-dir') || arg.startsWith('--app_data_dir'))) {
    process.stderr.write('flags provided but not defined\n');
    process.exit(2);
  }
  const usageAppDataDir = join(baseHome, '.gemini', 'antigravity-cli');
  const account = readSyntheticAccount(usageAppDataDir);
  logInvocation({ mode: 'usage', accountId: account?.accountId ?? null });
  if (!account) {
    process.stderr.write('Authentication required. You are currently not signed in.\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response: '',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              {
                id: 'gemini-weekly',
                name: 'Weekly Limit Remaining',
                window: 'weekly',
                remaining_fraction: account.gemini7dRemaining,
                reset_time: '2026-12-01T00:00:00Z',
              },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              {
                id: '3p-5h',
                name: 'Five Hour Limit Remaining',
                window: '5h',
                remaining_fraction: account.claude5hRemaining,
                reset_time: '2026-11-27T00:00:00Z',
              },
            ],
          },
        ],
      },
    },
  }) + '\n');
  process.exit(0);
}

if (args[0] !== 'acp') {
  process.stderr.write(`Unexpected args: ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const geminiFlag = readFlag(args, ['--gemini-dir', '--gemini_dir']) || '.gemini';
const appDataFlag = readFlag(args, ['--app-data-dir', '--app_data_dir']) || 'antigravity-cli';
const resolvedGeminiDir = resolve(baseHome, geminiFlag);
const resolvedAppDataDir = resolve(resolvedGeminiDir, appDataFlag);
const sessionsFile = join(resolvedAppDataDir, 'sessions.json');
const bootAccount = readSyntheticAccount(resolvedAppDataDir);
logInvocation({ mode: 'acp', accountId: bootAccount?.accountId ?? null, args, pid: process.pid });

function loadSessions() {
  if (!existsSync(sessionsFile)) return {};
  return JSON.parse(readFileSync(sessionsFile, 'utf8'));
}

function saveSessions(sessions) {
  mkdirSync(resolvedAppDataDir, { recursive: true });
  writeFileSync(sessionsFile, JSON.stringify(sessions));
}

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

const resumedSessions = new Set();
let waitingPrompt;

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'session/cancel' && waitingPrompt) {
    const { id, mode } = waitingPrompt;
    logInvocation({ mode: 'cancel', promptMode: mode });
    if (mode === 'wait-for-steer-ignore') return;
    waitingPrompt = undefined;
    if (mode === 'wait-for-steer-error') replyError(id, 'Simulated failed prompt during steering');
    else reply(id, { stopReason: 'cancelled' });
    return;
  }
  if (m.method === 'initialize') {
    reply(m.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'synthetic-agy', version: '1' },
    });
    return;
  }
  const account = readSyntheticAccount(resolvedAppDataDir);
  if (!account) {
    replyError(m.id, 'Authentication required');
    return;
  }
  if (m.method === 'session/new') {
    const sessions = loadSessions();
    const sessionId = `session-${account.accountId}-${Object.keys(sessions).length + 1}`;
    sessions[sessionId] = { accountId: account.accountId };
    saveSessions(sessions);
    reply(m.id, { sessionId });
    return;
  }
  if (m.method === 'session/load') {
    const sessionId = m.params?.sessionId;
    const sessions = loadSessions();
    if (process.env.SYNTHETIC_REBUILD === '1') {
      replyError(m.id, 'Simulated lost session during process rebuild');
      return;
    }
    if (!sessionId || !sessions[sessionId]) {
      replyError(m.id, `Session ${sessionId} not found in profile ${account.accountId}`);
      return;
    }
    resumedSessions.add(sessionId);
    reply(m.id, {});
    return;
  }
  if (m.method === 'session/prompt') {
    const sessionId = m.params?.sessionId;
    if (!loadSessions()[sessionId]) {
      replyError(m.id, 'Session not found');
      return;
    }
    logInvocation({ mode: 'prompt', accountId: account.accountId });
    const waitForSteer = m.params.prompt.find(part => part.text?.startsWith('wait-for-steer'));
    if (waitForSteer) {
      waitingPrompt = { id: m.id, mode: waitForSteer.text };
      if (waitForSteer.text === 'wait-for-steer-rebuild') {
        send({
          jsonrpc: '2.0', method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'synthetic-steer-call', title: 'Synthetic tool', kind: 'other', status: 'in_progress' },
          },
        });
      }
      return;
    }
    if (m.params.prompt.some(part => part.text === 'hold')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call', toolCallId: 'synthetic-task', title: 'run_command',
            kind: 'execute', status: 'in_progress',
            rawInput: { CommandLine: 'synthetic-test', toolSummary: 'Synthetic task' },
          },
        },
      });
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: JSON.stringify({
              accountId: account.accountId,
              sessionId,
              resumed: resumedSessions.has(sessionId),
            }),
          },
        },
      },
    });
    reply(m.id, { stopReason: 'end_turn' });
  }
});
