// Drives the real SDK ACP bridge through host.ts against fake-acp-background.mjs and checks the
// turn lifecycle BB sees on stdout. Run by turn-hold-integration.test.mjs in a child process.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { experimental_providerBridge as bridge } from '../host.ts';

const originalWrite = process.stdout.write.bind(process.stdout);
const messages = [];
let pending = '';
process.stdout.write = chunk => {
  pending += String(chunk);
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    messages.push({ at: Date.now(), message: JSON.parse(pending.slice(0, end)) });
    pending = pending.slice(end + 1);
  }
  return true;
};
let nextId = 1;
const request = (method, params) => {
  const id = nextId++;
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return id;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate, label, timeoutMs = 15000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const match = messages.find(entry => predicate(entry.message));
    if (match) return match.message;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(messages.map(entry => entry.message))}`);
};
/** Every delta BB received for a thread, in order. */
const deltasFor = threadId => messages
  .filter(({ message }) => message.method === 'thread/delta' && message.params.threadId === threadId)
  .flatMap(({ message }) => message.params.deltas);
const indexOf = (deltas, predicate, label) => {
  const index = deltas.findIndex(predicate);
  assert.ok(index >= 0, `${label} missing: ${JSON.stringify(deltas)}`);
  return index;
};
const isText = text => delta => delta.kind === 'item.textDelta' && delta.text === text;
const isBoundary = delta => delta.kind === 'turn.boundary';

const options = {
  permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation: 'ask',
  providerOptions: { autoApprove: true, acpLaunchSpec: { displayName: 'Fake', command: process.execPath, args: [fileURLToPath(new URL('./fake-acp-background.mjs', import.meta.url))], env: {} } },
};
const requestIds = ['creq_23456789ab', 'creq_3456789abc', 'creq_456789abcd', 'creq_56789abcde', 'creq_6789abcdef', 'creq_789abcdefg'];
async function startThread(threadId) {
  const id = request('thread/start', { threadId, cwd: process.cwd(), instructionMode: 'append', options });
  const started = await wait(m => m.id === id, `${threadId} thread/start`);
  assert.ok(started.result?.providerThreadId, JSON.stringify(started));
  return started.result.providerThreadId;
}
async function prompt(threadId, providerThreadId, text) {
  request('turn/start', { threadId, providerThreadId, clientRequestId: requestIds.shift(), input: [{ type: 'text', text }], options });
  await wait(m => m.method === 'thread/delta' && m.params.threadId === threadId && m.params.deltas.some(d => d.kind === 'turn.open'), `${threadId} turn.open`);
}

async function case1() {
  // Background task + reactive wakeup: one turn, closed only after the wakeup's answer.
  const provider = await startThread('case1');
  await prompt('case1', provider, 'case1');
  await wait(m => m.params?.threadId === 'case1' && m.params.deltas?.some(isText('All tests passed.')), 'case1 reactive answer');
  await wait(m => m.params?.threadId === 'case1' && m.params.deltas?.some(isBoundary), 'case1 boundary');
  const deltas = deltasFor('case1');
  assert.equal(deltas.filter(isBoundary).length, 1, 'exactly one boundary');
  assert.equal(deltas.filter(d => d.kind === 'turn.open').length, 1, 'the reactive turn.open is absorbed');
  const waiting = indexOf(deltas, isText('Waiting for the tests to finish.'), 'waiting text');
  const open = indexOf(deltas, d => d.item?.type === 'backgroundTask' && d.kind === 'item.open', 'background task open');
  const close = indexOf(deltas, d => d.item?.type === 'backgroundTask' && d.kind === 'item.close', 'background task close');
  const answer = indexOf(deltas, isText('All tests passed.'), 'reactive answer');
  const boundary = indexOf(deltas, isBoundary, 'boundary');
  assert.ok(waiting < answer && open < close && answer < boundary && close < boundary, JSON.stringify(deltas));
  assert.equal(deltas[close].status, 'completed');
  assert.equal(deltas[boundary].status, 'completed');
}

async function case2() {
  // run_command still in_progress when the prompt ends: tracked, late result lands in the open turn.
  const provider = await startThread('case2');
  await prompt('case2', provider, 'case2');
  await wait(m => m.params?.threadId === 'case2' && m.params.deltas?.some(isText('E2E suite passed.')), 'case2 reactive answer');
  await wait(m => m.params?.threadId === 'case2' && m.params.deltas?.some(isBoundary), 'case2 boundary');
  const deltas = deltasFor('case2');
  assert.equal(deltas.filter(isBoundary).length, 1);
  assert.equal(deltas.filter(d => d.kind === 'turn.open').length, 1);
  const open = indexOf(deltas, d => d.item?.type === 'backgroundTask' && d.kind === 'item.open', 'orphan task open');
  assert.equal(deltas[open].item.familyId, 'case2-call');
  assert.equal(deltas[open].item.description, 'Run e2e suite');
  const lateClose = indexOf(deltas, d => d.kind === 'item.close' && d.key?.providerItemId === 'case2-call' && /42 passed/.test(JSON.stringify(d)) && d.item?.type !== 'backgroundTask', 'late command result');
  const settled = indexOf(deltas, d => d.item?.type === 'backgroundTask' && d.kind === 'item.close', 'orphan task close');
  assert.equal(deltas[settled].status, 'completed');
  assert.match(deltas[settled].item.summary, /42 passed/);
  const boundary = indexOf(deltas, isBoundary, 'boundary');
  assert.ok(open < lateClose && lateClose < boundary && settled < boundary, JSON.stringify(deltas));
}

async function daemon() {
  // IsDaemon commands never hold the turn.
  const provider = await startThread('daemon');
  await prompt('daemon', provider, 'daemon');
  await wait(m => m.params?.threadId === 'daemon' && m.params.deltas?.some(isBoundary), 'daemon boundary', 3000);
  assert.ok(deltasFor('daemon').some(d => d.item?.type === 'backgroundTask' && d.kind === 'item.open'));
}

async function steerThenStop() {
  // A task that never finishes: a steer continues the held turn, and stop releases it at once.
  const provider = await startThread('never');
  await prompt('never', provider, 'never');
  await wait(m => m.params?.threadId === 'never' && m.params.deltas?.some(isText('Waiting for the soak test.')), 'never waiting text');
  await sleep(500);
  assert.equal(deltasFor('never').filter(isBoundary).length, 0, 'turn is held while the task runs');
  const steerId = request('turn/steer', { threadId: 'never', providerThreadId: provider, expectedTurnId: 'turn-1', clientRequestId: requestIds.shift(), input: [{ type: 'text', text: 'please also lint' }], options });
  const steered = await wait(m => m.id === steerId, 'steer response');
  assert.equal(steered.error, undefined, JSON.stringify(steered));
  assert.deepEqual(steered.result, { threadId: 'never' });
  await wait(m => m.params?.threadId === 'never' && m.params.deltas?.some(isText('Steer handled.')), 'steer answer');
  await sleep(300);
  let deltas = deltasFor('never');
  assert.equal(deltas.filter(isBoundary).length, 0, 'the soak task still runs, so the turn stays held');
  assert.equal(deltas.filter(d => d.kind === 'turn.open').length, 1, 'the steer prompt continues the same turn');
  const stopId = request('thread/stop', { threadId: 'never', providerThreadId: provider, intent: 'interrupt', activeTurnId: 'turn-1' });
  await wait(m => m.id === stopId, 'stop response');
  deltas = deltasFor('never');
  const boundaries = deltas.filter(isBoundary);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].status, 'interrupted');
  assert.equal(deltas.find(d => d.item?.type === 'backgroundTask' && d.kind === 'item.close')?.status, 'interrupted');
}

try {
  request('initialize', { protocolVersion: 1, client: { name: 'test', version: '1' } });
  await wait(m => m.id === 1 && m.result, 'initialize');
  await Promise.all([case1(), case2(), daemon(), steerThenStop()]);
  bridge.onClose?.();
  originalWrite('verified\n');
} catch (error) {
  process.stderr.write(String(error.stack || error) + '\n');
  bridge.onClose?.();
  process.exitCode = 1;
}
