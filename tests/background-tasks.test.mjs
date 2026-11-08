import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackgroundTaskTracker, normalizeFileUri, deriveTranscriptPathFromLogFile, extractToolOutputText } from '../background-tasks.ts';

const command = (id = 'conv/task-1', extra = {}) => ({ toolCallId: `call:${id}`, title: 'run_command', status: 'completed', content: [{ type: 'text', text: `Tool is running as a background task with task id: ${id}\nTask Description: build\n` }], ...extra });
const agent = (id = 'agent-1') => ({ toolCallId: `call:${id}`, title: 'invoke_subagent', status: 'completed', rawInput: { Role: 'Research' }, rawOutput: { conversationId: id } });
const manage = (title, Action, input = {}, text = '') => ({ toolCallId: 'manage', title, status: 'completed', rawInput: { Action, ...input }, content: text });
function tracker(t, options = {}) { const value = createBackgroundTaskTracker({ pollIntervalMs: 0, ...options }); t.after(() => value.dispose()); return value; }

test('file normalization, transcript derivation, and nested output extraction', () => {
  assert.equal(normalizeFileUri(' file:///C:/brain/task.log '), 'C:/brain/task.log');
  assert.equal(normalizeFileUri('file:///tmp/task.log'), '/tmp/task.log');
  assert.equal(normalizeFileUri('/tmp/task.log'), '/tmp/task.log');
  assert.equal(deriveTranscriptPathFromLogFile('C:\\brain\\.system_generated\\tasks\\task-1.log'), 'C:/brain/.system_generated/logs/transcript.jsonl');
  assert.equal(deriveTranscriptPathFromLogFile('/other.log'), null);
  assert.equal(extractToolOutputText({ toolCallId: 'x', content: [{ text: 'one' }, { content: [{ text: 'two' }] }], rawOutput: { output: 'three' } }), 'one\ntwo\nthree');
});
test('command opens with full BB shape and duplicates are ignored', t => {
  const tr = tracker(t);
  const [open] = tr.handleToolEventForThread('thread', command());
  assert.deepEqual(open, {
    kind: 'item.open', attach: 'currentOrLast', key: { providerItemId: 'task:conv/task-1', parentRef: 'call:conv/task-1' },
    item: { type: 'backgroundTask', familyId: 'conv/task-1', taskType: 'local_bash', description: 'build', status: 'pending', taskStatus: 'running', skipTranscript: false, foreground: false },
    presentation: { label: { pending: 'Running background command', completed: 'Background command finished' }, icon: { glyph: 'Terminal' }, title: 'build' },
  });
  assert.deepEqual(tr.handleToolEventForThread('thread', command()), []);
  assert.deepEqual(tr.handleToolEventForThread('thread', command('pending', { status: 'in_progress' })), []);
  const [close] = tr.clearThread('thread', true);
  assert.equal(close.status, 'interrupted'); assert.equal(close.item.taskStatus, 'stopped');
  assert.deepEqual(close.key, open.key); assert.deepEqual(close.presentation, open.presentation);
});
test('description priority and alternate command format', t => {
  const tr = tracker(t);
  for (const [input, expected] of [[{ toolSummary: 'summary', CommandLine: 'cmd' }, 'summary'], [{ toolSummary: ' ', CommandLine: 'cmd' }, 'cmd'], [{ command: 'lower' }, 'lower'], [{ Prompt: 'prompt' }, 'prompt'], [{}, 'id']]) {
    const [open] = tr.handleToolEventForThread('t', command('id', { title: 'schedule', rawInput: input, content: 'Background command ID: id' }));
    assert.equal(open.item.description, expected); tr.clearThread('t');
  }
  const [open] = tr.handleToolEventForThread('t', command('id', { kind: 'run_command', title: 'Custom title', content: 'Background command ID: id\nTask logs are available at: file:///C:/brain/.system_generated/tasks/task-1.log' }));
  assert.equal(open.item.description, 'Custom title'); assert.equal(open.item.outputFile, 'C:/brain/.system_generated/tasks/task-1.log');
});
test('native subagent detection variants and description priorities', t => {
  const tr = tracker(t);
  for (const extra of [{ rawOutput: { conversationId: 'a' } }, { content: '{"conversationId": "a"}' }, { content: 'Subagent spawned with conversationId: a' }]) {
    const [open] = tr.handleToolEventForThread('t', { toolCallId: 'call', title: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'worker' }, ...extra });
    assert.equal(open.key.providerItemId, 'subagent:a'); assert.equal(open.item.description, 'worker');
    assert.equal(open.item.taskType, 'local_subagent'); assert.equal(open.presentation.icon.glyph, 'Bot'); tr.clearThread('t');
  }
});
test('manage_task status recognizes terminal outcomes and rejects running reports', t => {
  const tr = tracker(t);
  for (const [text, status, taskStatus] of [
    ['Command exited with code 0', 'completed', 'completed'], ['Command exited with code 12', 'failed', 'failed'],
    ['SCHEDULE_FINISHED', 'completed', 'completed'], ['Step was canceled', 'interrupted', 'killed'],
    ['status=ERROR', 'failed', 'failed'], ['status: FAILED', 'failed', 'failed'], ['status=KILLED', 'interrupted', 'killed'],
    ['status=STOPPED', 'completed', 'completed'], ['not running', 'completed', 'completed'], ['not found', 'completed', 'completed'],
    ['unknown task', 'completed', 'completed'], ['finished with result', 'completed', 'completed'],
  ]) {
    tr.handleToolEventForThread('t', command('id'));
    const [close] = tr.handleToolEventForThread('t', manage('manage_task', 'STATUS', { TaskId: 'id' }, text));
    assert.equal(close.status, status, text); assert.equal(close.item.taskStatus, taskStatus);
  }
  tr.handleToolEventForThread('t', command('id'));
  for (const text of ['Step is still running; Command exited with code 0', 'status=RUNNING; status=DONE', 'unrecognized']) assert.deepEqual(tr.handleToolEventForThread('t', manage('manage_task', 'status', { TaskId: 'id' }, text)), []);
  assert.equal(tr.handleToolEventForThread('t', manage('manage_task', 'kill', { TaskId: 'id' }))[0].item.taskStatus, 'killed');
});
test('list reconciliation respects thread and task type', t => {
  const tr = tracker(t);
  for (const thread of ['a', 'b']) { tr.handleToolEventForThread(thread, command('keep')); tr.handleToolEventForThread(thread, command('gone')); tr.handleToolEventForThread(thread, agent()); }
  assert.deepEqual(tr.handleToolEventForThread('a', manage('manage_task', 'list', {}, 'unrecognized')), []);
  const closed = tr.handleToolEventForThread('a', manage('manage_task', 'list', {}, '| Start Time | Task ID | Tool | Description |\nkeep'));
  assert.equal(closed.length, 1); assert.equal(closed[0].item.familyId, 'gone'); assert.equal(tr.getActiveTasks('b').length, 3);
  assert.equal(tr.handleToolEventForThread('a', manage('manage_task', 'list', {}, 'No running tasks')).length, 1);
  assert.equal(tr.getActiveTasks('a')[0].taskType, 'local_subagent');
});
test('subagent management handles selective kill, kill_all, and lists', t => {
  const tr = tracker(t);
  for (const id of ['a', 'b', 'c']) tr.handleToolEventForThread('t', agent(id));
  assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'kill', { ConversationIds: ['a'] }))[0].status, 'interrupted');
  assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'list', {}, 'b idle\nc running'))[0].item.familyId, 'b');
  assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'kill_all'))[0].item.familyId, 'c');
  for (const text of ['No active direct subagents', 'No active subagents', '[]']) {
    tr.handleToolEventForThread('t', agent()); assert.equal(tr.handleToolEventForThread('t', manage('manage_subagents', 'list', {}, text)).length, 1);
  }
});
test('completion announcements settle once and bound each result', t => {
  const tr = tracker(t);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) tr.handleToolEventForThread('t', command(id));
  tr.handleToolEventForThread('t', agent('native'));
  const results = tr.inspectTextForCompletions('t', 'Task id "a" finished with result: success\nTask id "b" finished with result: Command exited with code 3\nTask id "c" was canceled\nTask id "d" failed\nTask id "e" finished with result: Step was canceled\nTask id "f" finished with result: Encountered error\nSubagent native has gone idle');
  assert.deepEqual(results.map(d => d.status), ['completed', 'failed', 'interrupted', 'failed', 'interrupted', 'failed', 'completed']);
  assert.deepEqual(tr.inspectTextForCompletions('t', 'Task id "a" terminated'), []);
  assert.equal(tr.getActiveTasks('t').length, 0);
});
test('bridge correlation consumes latest event and inspects all text fields', t => {
  const tr = tracker(t);
  tr.recordToolEvent(command('id', { status: 'in_progress' })); tr.recordToolEvent(command('id'));
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: 't', deltas: [{ key: { providerItemId: 'call:id' } }] } });
  assert.equal(JSON.parse(tr.processStdoutLine(line)[0]).params.deltas[1].kind, 'item.open');
  assert.equal(JSON.parse(tr.processStdoutLine(line)[0]).params.deltas.length, 1);
  for (const field of ['delta', 'output', 'text']) {
    tr.handleToolEventForThread('t', command('id'));
    const entry = field === 'delta' ? { delta: { text: 'Task id "id" was killed' } } : { item: { [field]: 'Task id "id" was killed' } };
    const result = tr.processStdoutLine(JSON.stringify({ method: 'thread/delta', params: { threadId: 't', deltas: [entry] } }));
    assert.equal(JSON.parse(result[0]).params.deltas.at(-1).status, 'interrupted');
  }
  for (const value of ['not json', 'null', '{}']) assert.deepEqual(tr.processStdoutLine(value), [value]);
});
test('inbound stop/discard and dispose clear tracking; snapshots cannot mutate state', t => {
  const tr = tracker(t);
  for (const method of ['thread/stop', 'thread/discard']) {
    tr.handleToolEventForThread('t', command()); const snapshot = tr.getActiveTasks('t'); snapshot[0].description = 'mutated';
    assert.equal(tr.getActiveTasks('t')[0].description, 'build');
    tr.handleInboundRequest({ method, params: { threadId: 't' } }); assert.equal(tr.getActiveTasks('t').length, 0);
  }
  assert.deepEqual(tr.handleInboundRequest(null), []); tr.dispose(); assert.deepEqual(tr.handleToolEventForThread('t', command()), []);
});
test('polling tails only new complete JSONL records and stops after settlement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'background-tasks-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = join(dir, '.system_generated', 'logs'); mkdirSync(logs, { recursive: true });
  const path = join(logs, 'transcript.jsonl'); writeFileSync(path, 'Task id "id" was killed\n');
  const received = [];
  const tr = tracker(t, { pollIntervalMs: 10, onAsyncDeltas: (thread, deltas) => received.push({ thread, deltas }) });
  tr.handleToolEventForThread('t', command('id', { content: `Background command ID: id\nTask logs are available at: ${join(dir, '.system_generated', 'tasks', 'task-1.log')}` }));
  await new Promise(r => setTimeout(r, 35)); assert.equal(received.length, 0);
  const record = JSON.stringify({ message: 'Task id "id" finished with result: success' });
  appendFileSync(path, record.slice(0, 20)); await new Promise(r => setTimeout(r, 25)); assert.equal(received.length, 0);
  appendFileSync(path, record.slice(20) + '\n');
  for (let i = 0; i < 50 && !received.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received.length, 1); assert.equal(received[0].thread, 't'); assert.equal(received[0].deltas[0].status, 'completed');
  assert.equal(tr.getActiveTasks('t').length, 0);
  appendFileSync(path, record + '\n'); await new Promise(r => setTimeout(r, 25)); assert.equal(received.length, 1);
});
test('polling handles late transcript creation and cleans up on clear and dispose', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'background-late-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = join(dir, '.system_generated', 'logs'); mkdirSync(logs, { recursive: true });
  const path = join(logs, 'transcript.jsonl');
  const received = [];
  const tr = tracker(t, { pollIntervalMs: 5, onAsyncDeltas: (_, deltas) => received.push(...deltas) });
  const event = id => command(id, { content: `Background command ID: ${id}\nTask logs are available at: ${join(dir, '.system_generated', 'tasks', 'task.log')}` });
  tr.handleToolEventForThread('t', event('late'));
  await new Promise(r => setTimeout(r, 15));
  writeFileSync(path, 'Task id "late" finished with result: success\n');
  for (let i = 0; i < 50 && !received.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received.length, 1);
  tr.handleToolEventForThread('t', event('cleared')); tr.clearThread('t');
  appendFileSync(path, 'Task id "cleared" failed\n');
  tr.handleToolEventForThread('t', event('disposed')); tr.dispose();
  appendFileSync(path, 'Task id "disposed" failed\n');
  await new Promise(r => setTimeout(r, 20)); assert.equal(received.length, 1);
  const disabled = tracker(t, { onAsyncDeltas: () => assert.fail('disabled polling fired') });
  disabled.handleToolEventForThread('t', event('disabled'));
  appendFileSync(path, 'Task id "disabled" failed\n');
  await new Promise(r => setTimeout(r, 20)); assert.equal(disabled.getActiveTasks('t').length, 1);
});
test('structured empty subagent list closes active native agents', t => {
  const tr = tracker(t); tr.handleToolEventForThread('t', agent());
  const event = { ...manage('manage_subagents', 'list'), rawOutput: [] };
  assert.equal(tr.handleToolEventForThread('t', event)[0].status, 'completed');
});
