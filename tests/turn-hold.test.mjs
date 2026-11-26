import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBackgroundTaskTracker } from '../background-tasks.ts';

// Turn hold: a completed turn boundary is held while non-daemon background work started by the
// agent is still running, and released once the CLI's reactive follow-up turn ends.

function tracker(t, options = {}) {
  const async = [];
  const value = createBackgroundTaskTracker({ pollIntervalMs: 0, onAsyncDeltas: (threadId, deltas) => async.push({ threadId, deltas }), ...options });
  t.after(() => value.dispose());
  return Object.assign(value, { async });
}
/** Feeds one bridge `thread/delta` line; returns the forwarded deltas ([] when the whole line was held). */
function line(tr, threadId, ...deltas) {
  const out = tr.processStdoutLine(JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId, deltas } }));
  return out.flatMap(text => JSON.parse(text).params.deltas);
}
const kinds = deltas => deltas.map(d => d.kind);
/** Polls until a timer-driven condition holds (fixed sleeps are flaky on loaded CI runners). */
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), 'condition not reached in time');
}
const boundary = (status = 'completed') => ({ kind: 'turn.boundary', status, claimIfIdle: true });
const turnOpen = () => ({ kind: 'turn.open' });
const agentText = text => ({ kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text });
const backgroundCommand = (id, rawInput = {}, extraText = '') => ({
  toolCallId: `call:${id}`, title: 'run_command', status: 'completed',
  rawInput: { CommandLine: 'npm test', toolSummary: 'Run tests', ...rawInput },
  content: [{ type: 'text', text: `Tool is running as a background task with task id: ${id}\nTask Description: Run tests\n${extraText}` }],
});
const sameKeyClose = (event, extra = {}) => ({ kind: 'item.close', status: 'completed', key: { providerItemId: event.toolCallId }, item: { type: 'command', command: 'npm test', cwd: '' }, noTurnFallback: { raw: { params: { update: event } } }, ...extra });
const commandUpdate = (toolCallId, status, extra = {}) => ({ toolCallId, title: 'run_command', status, rawInput: { CommandLine: 'npm run e2e', toolSummary: 'Run e2e suite' }, ...extra });
/** Turn N: the agent starts a background command, says it is waiting, and the prompt ends. */
function startBackgroundTurn(tr, thread, id, rawInput) {
  const event = backgroundCommand(id, rawInput);
  return line(tr, thread, sameKeyClose(event), agentText('Waiting for the tests to finish.'), boundary());
}

test('holds a completed boundary while a background command runs and releases it after the reactive turn', t => {
  const tr = tracker(t);
  const first = startBackgroundTurn(tr, 't', 'conv/task-1');
  assert.ok(!kinds(first).includes('turn.boundary'), 'boundary must not reach BB while the command runs');
  assert.ok(first.some(d => d.item?.type === 'backgroundTask' && d.kind === 'item.open'));
  assert.equal(tr.isHoldingTurn('t'), true);
  // The CLI wakes the model on its own: the bridge opens an agent turn, which is absorbed
  // (a line that only carried the turn.open is dropped entirely).
  assert.deepEqual(tr.processStdoutLine(JSON.stringify({ method: 'thread/delta', params: { threadId: 't', deltas: [turnOpen()] } })), []);
  assert.deepEqual(kinds(line(tr, 't', agentText('All 120 tests passed.'))), ['item.textDelta']);
  const end = line(tr, 't', boundary());
  assert.deepEqual(kinds(end), ['turn.boundary']);
  assert.equal(tr.isHoldingTurn('t'), false);
  // The task stays visible as running, but it no longer holds later turns (its end was never observed).
  assert.equal(tr.getActiveTasks('t').length, 1);
  assert.deepEqual(kinds(line(tr, 't', boundary())), ['turn.boundary']);
});

test('daemon commands, interrupted boundaries, and holdTurns:false never hold', t => {
  const tr = tracker(t);
  assert.ok(kinds(startBackgroundTurn(tr, 'daemon', 'conv/server', { IsDaemon: true })).includes('turn.boundary'));
  assert.equal(tr.getActiveTasks('daemon').length, 1);
  const cron = { toolCallId: 'call:cron', title: 'schedule', status: 'completed', rawInput: { Prompt: 'check CI', CronExpression: '*/5 * * * *' }, content: 'Background command ID: conv/cron-1' };
  assert.ok(kinds(line(tr, 'schedule', sameKeyClose(cron), boundary())).includes('turn.boundary'), 'schedules never hold');
  assert.equal(tr.getActiveTasks('schedule').length, 1);
  tr.handleToolEventForThread('stopped', backgroundCommand('conv/build'));
  assert.deepEqual(kinds(line(tr, 'stopped', boundary('interrupted'))), ['turn.boundary']);
  assert.deepEqual(kinds(line(tr, 'stopped', { kind: 'turn.boundary' })), ['turn.boundary']);
  const off = tracker(t, { holdTurns: false });
  assert.ok(kinds(startBackgroundTurn(off, 't', 'conv/task-1')).includes('turn.boundary'));
  // No background work at all: the boundary passes untouched.
  const plain = boundary();
  assert.deepEqual(tr.processStdoutLine(JSON.stringify({ method: 'thread/delta', params: { threadId: 'idle', deltas: [plain] } })),
    [JSON.stringify({ method: 'thread/delta', params: { threadId: 'idle', deltas: [plain] } })]);
});

test('observable tasks keep the turn held across reactive turns until they settle; a missed wakeup releases after the grace period', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-hold-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = join(dir, '.system_generated', 'logs'); mkdirSync(logs, { recursive: true });
  const transcript = join(logs, 'transcript.jsonl'); writeFileSync(transcript, '');
  const fileUri = path => { const slashed = path.replace(/\\/g, '/'); return `file://${slashed.startsWith('/') ? '' : '/'}${slashed}`; };
  const log = id => `Task logs are available at: ${fileUri(join(dir, '.system_generated', 'tasks', `${id}.log`))}`;
  const tr = tracker(t, { pollIntervalMs: 5, holdSettleGraceMs: 40 });
  const a = backgroundCommand('conv/task-a', {}, log('task-a'));
  const b = backgroundCommand('conv/task-b', {}, log('task-b'));
  assert.ok(!kinds(line(tr, 't', sameKeyClose(a), sameKeyClose(b), boundary())).includes('turn.boundary'));
  // Task A finishes; the CLI wakes the model, which reports and stops again while B still runs.
  appendFileSync(transcript, `${JSON.stringify({ content: 'Task id "conv/task-a" finished with result: Command exited with code 0' })}\n`);
  await sleep(60);
  assert.equal(tr.getActiveTasks('t').length, 1);
  assert.equal(tr.isHoldingTurn('t'), true, 'a settled task with others still running must not release');
  line(tr, 't', turnOpen(), agentText('A passed, still waiting for B.'));
  assert.deepEqual(line(tr, 't', boundary()), [], 'B is still running and observable: re-hold');
  // Task B finishes but no reactive turn ever arrives: the grace period releases the turn.
  appendFileSync(transcript, `${JSON.stringify({ content: 'Task id "conv/task-b" finished with result: Command exited with code 1' })}\n`);
  await until(() => !tr.isHoldingTurn('t'));
  const released = tr.async.flatMap(entry => entry.deltas);
  assert.deepEqual(released.filter(d => d.kind === 'item.close').map(d => [d.item.familyId, d.status]), [['conv/task-a', 'completed'], ['conv/task-b', 'failed']]);
  assert.equal(released.at(-1).kind, 'turn.boundary');
  assert.equal(released.at(-1).status, 'completed');
  assert.equal(released.filter(d => d.kind === 'turn.boundary').length, 1);
});

test('a reactive turn that starts within the grace period cancels the timed release', async t => {
  const tr = tracker(t, { holdSettleGraceMs: 30 });
  startBackgroundTurn(tr, 't', 'conv/task-1');
  tr.inspectTextForCompletions('t', 'Task id "conv/task-1" finished with result: done');
  line(tr, 't', turnOpen());
  await sleep(60);
  assert.equal(tr.isHoldingTurn('t'), true, 'the absorbed turn owns the release now');
  assert.equal(tr.async.some(entry => entry.deltas.some(d => d.kind === 'turn.boundary')), false);
  assert.deepEqual(kinds(line(tr, 't', agentText('Done.'), boundary())), ['item.textDelta', 'turn.boundary']);
});

test('a run_command left in progress when the prompt ends is tracked, holds the turn, and settles from the late update', async t => {
  const tr = tracker(t, { holdSettleGraceMs: 20 });
  const call = 'call:e2e';
  line(tr, 't', { kind: 'item.open', key: { providerItemId: call }, item: { type: 'command', command: 'npm run e2e', cwd: '' }, noTurnFallback: { raw: { params: { update: commandUpdate(call, 'in_progress') } } } });
  // end_turn: the bridge force-closes the still-running call (no fallback, empty output) and ends the turn.
  const flushed = line(tr, 't', { kind: 'item.close', status: 'completed', key: { providerItemId: call }, item: { type: 'command', command: 'npm run e2e', cwd: '' } }, boundary());
  assert.ok(!kinds(flushed).includes('turn.boundary'));
  const open = flushed.find(d => d.item?.type === 'backgroundTask');
  assert.equal(open.kind, 'item.open'); assert.equal(open.item.familyId, call); assert.equal(open.item.description, 'Run e2e suite');
  assert.equal(open.key.parentRef, call);
  // The late completion is now delivered inside the still-open BB turn and settles the task.
  const late = commandUpdate(call, 'completed', { content: [{ type: 'text', text: 'Command exited with code 0\nOutput:\n42 passed' }] });
  const settled = line(tr, 't', { kind: 'item.close', status: 'completed', key: { providerItemId: call }, item: { type: 'command' }, noTurnFallback: { raw: { params: { update: late } } } });
  const close = settled.find(d => d.item?.type === 'backgroundTask');
  assert.equal(close.status, 'completed'); assert.match(close.item.summary, /42 passed/);
  assert.equal(tr.getActiveTasks('t').length, 0);
  // No wakeup follows: the grace period releases the held boundary.
  await until(() => !tr.isHoldingTurn('t'));
  assert.deepEqual(tr.async.flatMap(entry => entry.deltas).map(d => d.kind), ['turn.boundary']);

  // Failing late result and daemon variants.
  line(tr, 'f', { kind: 'item.open', key: { providerItemId: call }, noTurnFallback: { raw: { params: { update: commandUpdate(call, 'in_progress') } } } });
  line(tr, 'f', { kind: 'item.close', status: 'completed', key: { providerItemId: call } }, boundary());
  const failed = line(tr, 'f', { kind: 'item.close', status: 'failed', key: { providerItemId: call }, noTurnFallback: { raw: { params: { update: commandUpdate(call, 'completed', { content: 'Command exited with code 2' }) } } } });
  assert.equal(failed.find(d => d.item?.type === 'backgroundTask').status, 'failed');
  line(tr, 'd', { kind: 'item.open', key: { providerItemId: call }, noTurnFallback: { raw: { params: { update: commandUpdate(call, 'in_progress', { rawInput: { CommandLine: 'npm run dev', IsDaemon: true } }) } } } });
  assert.ok(kinds(line(tr, 'd', { kind: 'item.close', status: 'completed', key: { providerItemId: call } }, boundary())).includes('turn.boundary'));
  // Non-command calls and interrupted flushes are not treated as running commands.
  line(tr, 'n', { kind: 'item.open', key: { providerItemId: 'read' }, noTurnFallback: { raw: { params: { update: { toolCallId: 'read', title: 'view_file', status: 'in_progress', rawInput: { Path: 'a', StartLine: 1 } } } } } });
  assert.ok(kinds(line(tr, 'n', { kind: 'item.close', status: 'completed', key: { providerItemId: 'read' } }, boundary())).includes('turn.boundary'));
  line(tr, 'i', { kind: 'item.open', key: { providerItemId: call }, noTurnFallback: { raw: { params: { update: commandUpdate(call, 'in_progress') } } } });
  assert.equal(line(tr, 'i', { kind: 'item.close', status: 'interrupted', key: { providerItemId: call } }).length, 1);
  assert.equal(tr.getActiveTasks('i').length, 0);
});

test('thread/stop and thread/discard close a held turn as interrupted immediately', t => {
  for (const method of ['thread/stop', 'thread/discard']) {
    const tr = tracker(t);
    startBackgroundTurn(tr, 't', 'conv/task-1');
    const deltas = tr.handleInboundRequest({ method, params: { threadId: 't', intent: 'interrupt' } });
    assert.deepEqual(deltas.map(d => d.kind), ['item.close', 'turn.boundary']);
    assert.equal(deltas[0].status, 'interrupted'); assert.equal(deltas[1].status, 'interrupted');
    assert.equal(tr.isHoldingTurn('t'), false);
    assert.deepEqual(tr.handleInboundRequest({ method, params: { threadId: 't' } }), [], 'a second stop has nothing left to release');
  }
});

for (const method of ['thread/stop', 'thread/discard']) {
  test(`${method} during an absorbed turn drops the late boundary`, t => {
    const tr = tracker(t);
    startBackgroundTurn(tr, 't', 'conv/task-1');
    line(tr, 't', turnOpen(), agentText('Tests finished, summarising'));
    const deltas = tr.handleInboundRequest({ method, params: { threadId: 't', intent: 'interrupt' } });
    assert.equal(deltas.filter(d => d.kind === 'turn.boundary').length, 1);
    // stopSession settles the agent turn with `cancelled`; BB's turn is already closed.
    assert.deepEqual(line(tr, 't', boundary('interrupted')), []);
    // The next real turn is unaffected.
    assert.deepEqual(kinds(line(tr, 't', turnOpen())), ['turn.open']);
    assert.deepEqual(kinds(line(tr, 't', boundary())), ['turn.boundary']);
  });
}

test('a new turn/start closes the held turn first; a turn/steer continues it', t => {
  const tr = tracker(t);
  startBackgroundTurn(tr, 't', 'conv/task-1');
  const start = { method: 'turn/start', params: { threadId: 't', input: [] } };
  const routed = tr.handleInbound(start);
  assert.equal(routed.request, start);
  assert.deepEqual(routed.deltas.map(d => [d.kind, d.status]), [['turn.boundary', 'completed']]);
  assert.deepEqual(kinds(line(tr, 't', turnOpen())), ['turn.open'], 'the new turn opens normally');
  // The first command's end was never observed, so it does not hold this turn; a new background command does.
  assert.deepEqual(startBackgroundTurn(tr, 't', 'conv/task-2').filter(d => d.kind === 'turn.boundary'), []);

  // BB steers what it sees as the running turn; the idle bridge would reject a steer, so it becomes a prompt.
  const steer = { jsonrpc: '2.0', id: 9, method: 'turn/steer', params: { threadId: 't', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'also run lint' }] } };
  const rewritten = tr.handleInbound(steer);
  assert.equal(rewritten.request.method, 'turn/start'); assert.equal(rewritten.request.id, 9);
  assert.deepEqual(rewritten.request.params, steer.params);
  assert.deepEqual(rewritten.deltas, []);
  assert.equal(steer.method, 'turn/steer', 'the original request is not mutated');
  assert.deepEqual(line(tr, 't', turnOpen()), [], 'the steer prompt continues the held BB turn');
  tr.inspectTextForCompletions('t', 'Task id "conv/task-2" finished with result: ok');
  assert.deepEqual(kinds(line(tr, 't', agentText('Lint and tests pass.'), boundary())), ['item.textDelta', 'turn.boundary']);
  // A steer while the bridge is itself running a turn is left for the bridge.
  startBackgroundTurn(tr, 't', 'conv/task-3');
  line(tr, 't', turnOpen());
  assert.equal(tr.handleInbound(steer).request, steer);
  // Without a hold nothing is rewritten.
  assert.equal(tr.handleInbound({ ...steer, params: { ...steer.params, threadId: 'idle' } }).request.method, 'turn/steer');
});

test('a rejected steer interrupts the held turn instead of waiting for the cap', t => {
  const tr = tracker(t);
  startBackgroundTurn(tr, 't', 'conv/task-1');
  const { request } = tr.handleInbound({ jsonrpc: '2.0', id: 'steer-7', method: 'turn/steer', params: { threadId: 't', input: [] } });
  assert.equal(request.method, 'turn/start');
  const rejection = JSON.stringify({ jsonrpc: '2.0', id: 'steer-7', error: { code: -32000, message: 'No active ACP session' } });
  const out = tr.processStdoutLine(rejection);
  assert.equal(out[0], rejection, 'the error still reaches BB');
  assert.deepEqual(out.slice(1).flatMap(text => JSON.parse(text).params.deltas).map(d => [d.kind, d.status]), [['turn.boundary', 'interrupted']]);
  assert.equal(tr.isHoldingTurn('t'), false);
  // An accepted steer leaves the hold alone; unrelated responses pass through untouched.
  startBackgroundTurn(tr, 'u', 'conv/task-2');
  tr.handleInbound({ jsonrpc: '2.0', id: 8, method: 'turn/steer', params: { threadId: 'u', input: [] } });
  const accepted = JSON.stringify({ jsonrpc: '2.0', id: 8, result: { threadId: 'u' } });
  assert.deepEqual(tr.processStdoutLine(accepted), [accepted]);
  assert.equal(tr.isHoldingTurn('u'), true);
  const other = JSON.stringify({ jsonrpc: '2.0', id: 9, error: { code: 1, message: 'x' } });
  assert.deepEqual(tr.processStdoutLine(other), [other]);
});

test('turn/start keeps the absorbed prompt attached until its bridge boundary', t => {
  const tr = tracker(t);
  startBackgroundTurn(tr, 't', 'conv/task-1');
  line(tr, 't', turnOpen());
  const { deltas } = tr.handleInbound({ method: 'turn/start', params: { threadId: 't' } });
  assert.deepEqual(deltas, []);
  // Text remains attached until the SDK closes its agent turn.
  assert.deepEqual(kinds(line(tr, 't', agentText('final detail'), boundary())), ['item.textDelta', 'turn.boundary']);
  assert.deepEqual(kinds(line(tr, 't', turnOpen())), ['turn.open']);
});

test('the hold cap releases a turn whose work never finishes and exempts that work from later holds', async t => {
  const tr = tracker(t, { maxTurnHoldMs: 20 });
  startBackgroundTurn(tr, 't', 'conv/dev-server');
  await until(() => !tr.isHoldingTurn('t'));
  assert.deepEqual(tr.async.flatMap(entry => entry.deltas).map(d => [d.kind, d.status]), [['turn.boundary', 'completed']]);
  assert.deepEqual(kinds(line(tr, 't', boundary())), ['turn.boundary'], 'later turns are not held for the same task');
  assert.equal(tr.getActiveTasks('t').length, 1, 'the task itself stays tracked and visible');
  // A new background task in a later turn holds again.
  assert.deepEqual(startBackgroundTurn(tr, 't', 'conv/task-2').filter(d => d.kind === 'turn.boundary'), []);
});

test('the cap lets an active prompt finish streaming before it closes the turn', async t => {
  const tr = tracker(t, { maxTurnHoldMs: 20 });
  startBackgroundTurn(tr, 't', 'conv/task-1');
  line(tr, 't', turnOpen());
  await sleep(60);
  assert.deepEqual(tr.async, []);
  assert.deepEqual(kinds(line(tr, 't', agentText('Still here'), sameKeyClose(backgroundCommand('conv/new')), boundary())),
    ['item.textDelta', 'item.close', 'item.open', 'turn.boundary']);
  assert.equal(tr.isHoldingTurn('t'), false);
});

test('provider errors that settle the turn end the hold without an extra boundary', async t => {
  const tr = tracker(t, { maxTurnHoldMs: 20 });
  startBackgroundTurn(tr, 't', 'conv/task-1');
  const error = { kind: 'provider.error', message: 'Provider error', detail: 'exited', settlesTurn: true };
  assert.deepEqual(line(tr, 't', error), [error]);
  assert.equal(tr.isHoldingTurn('t'), false);
  await sleep(50);
  assert.deepEqual(tr.async, []);
});

test('the silent-turn warning is evaluated when the held turn is finally released', t => {
  const tr = tracker(t);
  tr.handleToolEventForThread('t', backgroundCommand('conv/task-1'));
  const failedEmpty = { kind: 'item.close', status: 'failed', key: { providerItemId: 'call:x' }, item: { type: 'command', command: 'x', cwd: '' }, exitCode: 1 };
  assert.deepEqual(line(tr, 't', failedEmpty, boundary()).map(d => d.kind), ['item.close']);
  line(tr, 't', turnOpen());
  const end = line(tr, 't', boundary());
  assert.deepEqual(kinds(end), ['item.textDelta', 'item.textClose', 'turn.boundary']);
});

test('dispose clears pending hold timers', async t => {
  const tr = tracker(t, { maxTurnHoldMs: 20 });
  startBackgroundTurn(tr, 't', 'conv/task-1');
  tr.dispose();
  await sleep(50);
  assert.deepEqual(tr.async, []);
});
