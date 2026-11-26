import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, openSync, closeSync, renameSync, rmdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, utimesSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackgroundTaskTracker, normalizeFileUri, deriveTranscriptPathFromLogFile, extractToolOutputText, withTaskStateLock } from '../background-tasks.ts';

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
test('bridge correlation consumes queued events and inspects all text fields', t => {
  const tr = tracker(t);
  tr.recordToolEvent(command('id', { status: 'in_progress' })); tr.recordToolEvent(command('id'));
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: 't', deltas: [{ key: { providerItemId: 'call:id' } }] } });
  assert.equal(JSON.parse(tr.processStdoutLine(line)[0]).params.deltas.length, 1);
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
    const [close] = tr.handleInboundRequest({ method, params: { threadId: 't' } });
    assert.equal(close.kind, 'item.close'); assert.equal(close.status, 'interrupted'); assert.equal(close.item.taskStatus, 'stopped');
    assert.equal(tr.getActiveTasks('t').length, 0);
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

const stdout = (tr, threadId, ...deltas) => JSON.parse(tr.processStdoutLine(JSON.stringify({ method: 'thread/delta', params: { threadId, deltas } }))[0]).params.deltas;
test('short and qualified IDs settle the same task without matching prefixes in lists', t => {
  const tr = tracker(t);
  for (const action of ['status', 'kill']) {
    tr.handleToolEventForThread('t', command('conv/task-1'));
    const [close] = tr.handleToolEventForThread('t', manage('manage_task', action, { TaskId: 'task-1' }, 'Command exited with code 0'));
    assert.equal(close.item.familyId, 'conv/task-1');
    assert.equal(close.status, action === 'kill' ? 'interrupted' : 'completed');
  }
  tr.handleToolEventForThread('t', command('task-1'));
  assert.equal(tr.inspectTextForCompletions('t', 'Task id "conv/task-1" was killed')[0].item.familyId, 'task-1');
  const header = '| Start Time | Task ID | Tool | Description |\n';
  for (const listed of ['task-10', 'conv/task-10']) {
    tr.handleToolEventForThread('t', command('conv/task-1')); tr.handleToolEventForThread('t', command('conv/task-10'));
    const closed = tr.handleToolEventForThread('t', manage('manage_task', 'list', {}, header + `| now | ${listed} | run_command | build |`));
    assert.deepEqual(closed.map(d => d.item.familyId), ['conv/task-1']);
    assert.deepEqual(tr.getActiveTasks('t').map(task => task.taskId), ['conv/task-10']); tr.clearThread('t');
  }
  tr.handleToolEventForThread('t', command('conv/task-1'));
  assert.deepEqual(tr.handleToolEventForThread('t', manage('manage_task', 'list', {}, header + '| now | task-1 | run_command | build |')), []);
  for (const id of ['agent-1', 'agent-10', 'agent.x']) tr.handleToolEventForThread('t', agent(id));
  const closed = tr.handleToolEventForThread('t', manage('manage_subagents', 'list', {}, 'agent-10 idle\nagent-1 running\nagentXx idle'));
  assert.deepEqual(closed.map(d => d.item.familyId), ['agent-10']);
});
test('FIFO correlation keeps reused tool IDs and partial input isolated per thread', t => {
  const tr = tracker(t);
  const key = { providerItemId: 'shared' };
  for (const thread of ['a', 'b']) tr.recordToolEvent({ toolCallId: 'shared', title: 'run_command', status: 'in_progress', rawInput: { toolSummary: thread } });
  for (const thread of ['a', 'b']) assert.equal(stdout(tr, thread, { kind: 'item.open', key }).length, 1);
  for (const thread of ['a', 'b']) tr.recordToolEvent({ toolCallId: 'shared', status: 'completed', content: `Background command ID: ${thread}/task-1` });
  for (const thread of ['a', 'b']) {
    const deltas = stdout(tr, thread, { kind: 'item.close', key });
    assert.equal(deltas.at(-1).item.familyId, `${thread}/task-1`);
    assert.equal(deltas.at(-1).item.description, thread);
  }
  tr.inspectTextForCompletions('a', 'Task id "task-1" was killed');
  assert.equal(tr.getActiveTasks('a').length, 0); assert.equal(tr.getActiveTasks('b').length, 1);
});
test('thread-scoped fallback updates work without hooks and override unscoped events', t => {
  const tr = tracker(t);
  const entry = update => ({ kind: 'item.close', key: { providerItemId: 'shared' }, noTurnFallback: { raw: { params: { update } } } });
  for (const thread of ['a', 'b']) {
    stdout(tr, thread, entry({ toolCallId: 'shared', title: 'run_command', status: 'in_progress', rawInput: { toolSummary: thread } }));
  }
  tr.recordToolEvent(command('wrong', { toolCallId: 'shared' }));
  for (const thread of ['b', 'a']) {
    const deltas = stdout(tr, thread, entry({ toolCallId: 'shared', status: 'completed', content: `Background command ID: ${thread}/task-1` }));
    assert.equal(deltas.at(-1).item.description, thread);
    assert.equal(deltas.at(-1).item.familyId, `${thread}/task-1`);
  }
  tr.clearThread('a');
  assert.equal(stdout(tr, 'a', entry({ toolCallId: 'shared', status: 'completed', content: 'Background command ID: new' })).length, 1);
});
test('stream completion buffers span chunks, remain isolated, and flush at text close or boundary', t => {
  const tr = tracker(t);
  for (const flush of ['item.textClose', 'turn.boundary']) {
    for (const thread of ['a', 'b']) tr.handleToolEventForThread(thread, command('id'));
    for (const text of ['Task i', 'd "id" finished with result:\n', 'Command exited with code ', '1']) {
      assert.equal(stdout(tr, 'a', { kind: 'item.textDelta', text }).length, 1);
      assert.equal(tr.getActiveTasks('a').length, 1);
    }
    assert.equal(stdout(tr, 'b', { kind: flush }).length, 1);
    const deltas = stdout(tr, 'a', { kind: flush });
    const taskClose = deltas.find(delta => delta.kind === 'item.close');
    assert.equal(taskClose.status, 'failed');
    if (flush === 'turn.boundary') assert.equal(deltas.at(-1).kind, 'turn.boundary');
    assert.equal(tr.getActiveTasks('b').length, 1);
    assert.equal(stdout(tr, 'a', { kind: flush }).length, 1);
    tr.clearThread('b');
  }
  tr.handleToolEventForThread('a', command('id'));
  stdout(tr, 'a', { kind: 'item.textDelta', text: 'Task id "id" failed' }); tr.clearThread('a');
  tr.handleToolEventForThread('a', command('id'));
  assert.equal(stdout(tr, 'a', { kind: 'turn.boundary' }).length, 1);
  for (const field of ['resultText', 'aggregatedOutput', 'message']) {
    tr.handleToolEventForThread('a', command(field));
    assert.equal(stdout(tr, 'a', { [field]: `Task id "${field}" failed` }).at(-1).status, 'failed');
  }
});

const statePath = t => { const dir = mkdtempSync(join(tmpdir(), 'background-state-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'background-tasks.json'); };

test('registration persists a versioned record and settling removes it', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  const [open] = tr.handleToolEventForThread('thread', command('task-42'));
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(file.version, 1);
  assert.equal(file.tasks.length, 1);
  const [record] = file.tasks;
  assert.equal(record.threadId, 'thread'); assert.equal(record.taskId, 'task-42'); assert.equal(record.taskType, 'local_bash');
  assert.equal(record.description, 'build'); assert.equal(record.parentToolCallId, open.key.parentRef);
  assert.ok(Number.isFinite(record.startedAt) && Math.abs(record.startedAt - Date.now()) < 60_000);
  tr.handleToolEventForThread('thread', command('task-42')); // duplicate registration does not duplicate the record
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1);
  const [close] = tr.inspectTextForCompletions('thread', 'Task id "task-42" finished with result: success');
  assert.equal(close.status, 'completed');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
});

test('a tracker leaves a handed-off thread alone when saving another thread', t => {
  const path = statePath(t);
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('moved', command('old'));
  first.clearThread('moved');
  const second = tracker(t, { persistPath: path });
  second.handleToolEventForThread('moved', command('new'));
  first.handleToolEventForThread('other', command('keep'));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.taskId).sort(), ['keep', 'new']);
});

test('a successful save retries failed task changes and preserves a handoff', t => {
  const path = statePath(t);
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('moved', command('old'));
  renameSync(path, path + '.saved');
  mkdirSync(path); // A directory at the target prevents the atomic rename.
  first.clearThread('moved');
  first.handleToolEventForThread('stays', command('retry-add'));
  rmdirSync(path);
  renameSync(path + '.saved', path);
  const second = tracker(t, { persistPath: path });
  second.handleToolEventForThread('moved', command('new'));
  first.handleToolEventForThread('other', command('trigger'));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.taskId).sort(),
    ['new', 'retry-add', 'trigger']);
});

test('a failed removal survives registration and removal of a replacement with the same task ID', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  tr.handleToolEventForThread('thread', command('same'));
  renameSync(path, path + '.saved');
  mkdirSync(path);
  tr.clearThread('thread');
  tr.handleToolEventForThread('thread', command('same', { toolCallId: 'replacement' }));
  rmdirSync(path);
  renameSync(path + '.saved', path);
  tr.clearThread('thread');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, []);
});

test('reconciliation preserves a replacement registered in the same millisecond', t => {
  t.mock.method(Date, 'now', () => 12345);
  const path = statePath(t);
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('thread', command('same'));
  const restarted = tracker(t, { persistPath: path });
  first.clearThread('thread');
  first.handleToolEventForThread('thread', command('same', { toolCallId: 'replacement' }));
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks[0].parentToolCallId, 'replacement');
});

test('a delayed addition retry preserves a same-millisecond replacement from another tracker', t => {
  t.mock.method(Date, 'now', () => 12345);
  const path = statePath(t);
  mkdirSync(path); // Force the first tracker's write to fail so its addition stays queued.
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('thread', command('same'));
  rmdirSync(path);
  const second = tracker(t, { persistPath: path });
  second.handleToolEventForThread('thread', command('same', { toolCallId: 'replacement' }));
  first.handleToolEventForThread('other', command('trigger'));
  const tasks = JSON.parse(readFileSync(path, 'utf8')).tasks;
  assert.deepEqual(tasks.map(task => task.taskId).sort(), ['same', 'trigger']);
  assert.equal(tasks.find(task => task.taskId === 'same').parentToolCallId, 'replacement');
});

test('simulated host restart emits interrupted close deltas on resume and drops the records', t => {
  const path = statePath(t);
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('thread', command('task-7'));
  first.handleToolEventForThread('thread', agent('worker-1'));
  first.handleToolEventForThread('other', command('untouched'));
  first.dispose(); // Host death: in-memory state is lost, the file keeps the records.
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 3);
  const restarted = tracker(t, { persistPath: path }); // Restarted plugin host.
  const deltas = restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } });
  assert.equal(deltas.length, 2);
  for (const close of deltas) {
    assert.equal(close.kind, 'item.close'); assert.equal(close.status, 'interrupted'); assert.equal(close.item.taskStatus, 'stopped');
  }
  assert.deepEqual(deltas.map(d => d.key.providerItemId).sort(), ['subagent:worker-1', 'task:task-7']);
  assert.deepEqual(deltas.map(d => d.key.parentRef).sort(), ['call:task-7', 'call:worker-1']);
  // Reconciled records drop, other threads' records survive untouched, and a second resume finds nothing.
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(file.tasks.map(r => r.threadId), ['other']);
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.deepEqual(restarted.handleInboundRequest({ method: 'turn/start', params: { threadId: 'thread' } }), []);
  assert.equal(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'other' } })[0].key.providerItemId, 'task:untouched');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
});

test('resume and turn/start leave tasks that are still tracked in memory alone', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path });
  tr.handleToolEventForThread('t', command('live'));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1);
  assert.deepEqual(tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
  assert.deepEqual(tr.handleInboundRequest({ method: 'turn/start', params: { threadId: 't' } }), []);
  tr.inspectTextForCompletions('t', 'Task id "live" finished with result: done');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
  tr.dispose();
  const restarted = tracker(t, { persistPath: path });
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
});

test('corrupt, truncated, or invalid state files degrade to empty state and get repaired', t => {
  const path = statePath(t);
  mkdirSync(dirname(path), { recursive: true });
  for (const corrupt of ['noise{{{', JSON.stringify({ version: 1, tasks: 'nope' }), JSON.stringify({ version: 2, tasks: [] }),
    JSON.stringify({ version: 1, tasks: [{ threadId: 't' }, null, 42] }), '']) {
    writeFileSync(path, corrupt);
    const tr = tracker(t, { persistPath: path }); // must not throw and must treat the file as empty
    assert.deepEqual(tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
    tr.handleToolEventForThread('t', command('ok')); // registration still works and rewrites a valid file
    const file = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(file.version, 1); assert.equal(file.tasks.length, 1); assert.equal(file.tasks[0].taskId, 'ok');
    tr.clearThread('t');
  }
});

test('stale persisted records are garbage-collected on startup and cannot reconcile', t => {
  const path = statePath(t);
  mkdirSync(dirname(path), { recursive: true });
  const record = (threadId, taskId, startedAt) => ({ threadId, taskId, taskType: 'local_bash', description: 'build', parentToolCallId: `call:${taskId}`, startedAt });
  writeFileSync(path, JSON.stringify({ version: 1, tasks: [
    record('stale', 'task-old', Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days, beyond the default max age
    record('fresh', 'task-new', Date.now() - 60_000),
  ] }));
  const tr = tracker(t, { persistPath: path }); // Startup load prunes the stale record already.
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(r => r.threadId), ['fresh']);
  assert.deepEqual(tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'stale' } }), []);
  const [close] = tr.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'fresh' } });
  assert.equal(close.key.providerItemId, 'task:task-new'); assert.equal(close.status, 'interrupted');
});

test('stale-record max age is configurable via taskStateMaxAgeMs', t => {
  const path = statePath(t);
  const tr = tracker(t, { persistPath: path, taskStateMaxAgeMs: 0 }); // Every record is immediately stale.
  tr.handleToolEventForThread('t', command('fleeting'));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 1); // Live tasks still persist their record.
  tr.dispose();
  // Expiry must not depend on whether restart crosses a millisecond boundary.
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.tasks[0].startedAt = Date.now() - 1000;
  writeFileSync(path, JSON.stringify(state));
  const restarted = tracker(t, { persistPath: path, taskStateMaxAgeMs: 0 });
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 't' } }), []);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
});

const writerFixturePath = fileURLToPath(new URL('./task-state-writer-fixture.mjs', import.meta.url));

function spawnWriter(t) {
  const child = spawn(process.execPath, ['--experimental-strip-types', writerFixturePath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((resolve, reject) => {
    const onMessage = msg => {
      if (msg?.type === 'online') {
        child.off('error', reject);
        resolve(msg.pid);
      }
    };
    child.on('message', onMessage);
    child.once('error', reject);
    child.once('exit', code => {
      for (const { reject: fail } of pending.values()) fail(new Error(`writer exited (${code}): ${stderr}`));
      pending.clear();
      reject(new Error(`writer exited before ready (${code}): ${stderr}`));
    });
  });
  child.on('message', msg => {
    if (msg?.type === 'ack' && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg?.type === 'error' && pending.has(msg.id)) {
      const { reject } = pending.get(msg.id);
      pending.delete(msg.id);
      reject(new Error(msg.message));
    } else if (msg?.type && listeners.has(msg.type)) {
      const callbacks = listeners.get(msg.type);
      listeners.delete(msg.type);
      for (const cb of callbacks) cb(msg);
    }
  });
  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      try { child.send({ type: 'exit' }); } catch {}
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 1000);
        timer.unref();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  });
  return {
    ready,
    send(payload) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ ...payload, id });
      });
    },
    onceEvent(type) {
      return new Promise(resolve => {
        const list = listeners.get(type) ?? [];
        list.push(resolve);
        listeners.set(type, list);
      });
    },
    killNow() {
      if (child.exitCode !== null) return Promise.resolve();
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      return done;
    },
    async close() {
      if (child.exitCode !== null) return;
      const done = new Promise(resolve => child.once('exit', resolve));
      try { child.send({ type: 'exit' }); } catch {}
      await done;
    },
  };
}

async function createDeadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return pid;
}

async function until(predicate, timeoutMs = 4_000, describe = () => 'condition not reached in time') {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), describe());
}

function readTaskPairs(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return null;
    return parsed.tasks.map(task => `${task.threadId}:${task.taskId}`).sort();
  } catch {
    return null;
  }
}

test('concurrent writer processes preserve all saved tasks and both threads recover after restart', async t => {
  const path = statePath(t);
  // Seed a legacy v1 record to confirm pre-existing data survives concurrent multi-host saves.
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    tasks: [{ threadId: 'legacy-thread', taskId: 'legacy-1', taskType: 'local_bash', description: 'legacy', parentToolCallId: 'call:legacy-1', startedAt: Date.now() }],
  })}\n`);
  const writerA = spawnWriter(t);
  const writerB = spawnWriter(t);
  await Promise.all([writerA.ready, writerB.ready]);
  await Promise.all([
    writerA.send({ type: 'init', persistPath: path }),
    writerB.send({ type: 'init', persistPath: path }),
  ]);

  const rounds = 12;
  for (let i = 0; i < rounds; i++) {
    await Promise.all([
      writerA.send({ type: 'register', threadId: 'thread-a', taskId: `a-task-${i}` }),
      writerB.send({ type: 'register', threadId: 'thread-b', taskId: `b-task-${i}` }),
    ]);
    if (i % 3 === 0) {
      await Promise.all([
        writerA.send({ type: 'settle', threadId: 'thread-a', taskId: `a-task-${i}` }),
        writerB.send({ type: 'settle', threadId: 'thread-b', taskId: `b-task-${i}` }),
      ]);
    }
  }

  const expectedA = Array.from({ length: rounds }, (_, i) => i).filter(i => i % 3 !== 0).map(i => `a-task-${i}`);
  const expectedB = Array.from({ length: rounds }, (_, i) => i).filter(i => i % 3 !== 0).map(i => `b-task-${i}`);
  const expectedPairs = [
    'legacy-thread:legacy-1',
    ...expectedA.map(id => `thread-a:${id}`),
    ...expectedB.map(id => `thread-b:${id}`),
  ].sort();
  // Let any contended writers finish their scheduled async retries before simulated host exit.
  await until(
    () => JSON.stringify(readTaskPairs(path)) === JSON.stringify(expectedPairs),
    4_000,
    () => `expected ${JSON.stringify(expectedPairs)}, got ${JSON.stringify(readTaskPairs(path))}, locks=${JSON.stringify(readdirSync(`${path}.locks`))}`,
  );
  await Promise.all([writerA.close(), writerB.close()]);

  const restarted = tracker(t, { persistPath: path });
  const recoveredA = restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread-a' } });
  const recoveredB = restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread-b' } });
  const recoveredLegacy = restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'legacy-thread' } });

  assert.deepEqual(recoveredA.map(d => d.key.providerItemId).sort(), expectedA.map(id => `task:${id}`).sort());
  assert.deepEqual(recoveredB.map(d => d.key.providerItemId).sort(), expectedB.map(id => `task:${id}`).sort());
  assert.deepEqual(recoveredLegacy.map(d => d.key.providerItemId), ['task:legacy-1']);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.length, 0);
  assert.deepEqual(readdirSync(dirname(path)).filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual(readdirSync(`${path}.locks`), []);
});

test('a paused live writer is never evicted and a contended writer flushes via scheduled retry', async t => {
  const path = statePath(t);
  const holder = spawnWriter(t);
  const waiter = spawnWriter(t);
  await Promise.all([holder.ready, waiter.ready]);
  await waiter.send({ type: 'init', persistPath: path });

  const locked = holder.onceEvent('locked');
  const holdPromise = holder.send({
    type: 'holdLockAndWrite',
    persistPath: path,
    holdMs: 300,
    threadId: 'thread-holder',
    taskId: 'holder-task',
  });
  await locked;

  const start = performance.now();
  await waiter.send({ type: 'register', threadId: 'thread-waiter', taskId: 'waiter-task' });
  const registerElapsed = performance.now() - start;
  assert.ok(registerElapsed < 200, `contended registration should not block for the paused writer (elapsed ${registerElapsed.toFixed(1)}ms)`);

  // While holder is still paused, its marker remains in <path>.locks and waiter has not overwritten the file.
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(existsSync(path), false, 'contended writer must not bypass the paused live writer');

  const holdAck = await holdPromise;
  assert.equal(holdAck.status, 'acquired');
  // Without any further events, waiter's scheduled retry timer flushes its queued task onto holder's saved state.
  await until(() => JSON.stringify(readTaskPairs(path)) === JSON.stringify(['thread-holder:holder-task', 'thread-waiter:waiter-task']));
  await Promise.all([holder.close(), waiter.close()]);

  const restarted = tracker(t, { persistPath: path });
  assert.deepEqual(
    restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread-holder' } }).map(d => d.key.providerItemId),
    ['task:holder-task'],
  );
  assert.deepEqual(
    restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread-waiter' } }).map(d => d.key.providerItemId),
    ['task:waiter-task'],
  );
  assert.deepEqual(readdirSync(`${path}.locks`), []);
});

test('a crashed lock owner is pruned safely and racing writers both persist without losing records', async t => {
  const path = statePath(t);
  const lockDir = `${path}.locks`;
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    tasks: [{ threadId: 'legacy', taskId: 'survives', taskType: 'local_bash', description: 'keep', parentToolCallId: 'call:survives', startedAt: Date.now() }],
  })}\n`);

  // 1. Kill a real process mid-lock so it crashes leaving its unique marker behind.
  const crashed = spawnWriter(t);
  await crashed.ready;
  const locked = crashed.onceEvent('locked');
  const crashedRequest = crashed.send({
    type: 'holdLockAndWrite',
    persistPath: path,
    holdMs: 30_000,
    write: false,
  });
  crashedRequest.catch(() => {});
  await locked;
  assert.equal(readdirSync(lockDir).length, 1);
  await crashed.killNow();
  assert.equal(readdirSync(lockDir).length, 1, 'crashed process leaves its marker behind');

  // 2. Also add a second dead-PID marker and race two independent writers to recover and save.
  const deadPid = await createDeadPid();
  writeFileSync(join(lockDir, `${deadPid}-${randomUUID()}.lock`), '');

  const writerA = spawnWriter(t);
  const writerB = spawnWriter(t);
  await Promise.all([writerA.ready, writerB.ready]);
  await Promise.all([
    writerA.send({ type: 'init', persistPath: path }),
    writerB.send({ type: 'init', persistPath: path }),
  ]);
  await Promise.all([
    writerA.send({ type: 'register', threadId: 'a', taskId: 'from-a' }),
    writerB.send({ type: 'register', threadId: 'b', taskId: 'from-b' }),
  ]);
  await until(() => JSON.stringify(readTaskPairs(path)) === JSON.stringify(['a:from-a', 'b:from-b', 'legacy:survives']));
  await Promise.all([writerA.close(), writerB.close()]);
  assert.deepEqual(readdirSync(lockDir), []);
});

test('concurrent startup GC with a live writer preserves new and fresh legacy tasks', async t => {
  const path = statePath(t);
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    tasks: [
      { threadId: 'stale', taskId: 'old', taskType: 'local_bash', description: 'old', parentToolCallId: 'call:old', startedAt: Date.now() - 10 * 24 * 60 * 60 * 1000 },
      { threadId: 'legacy', taskId: 'fresh', taskType: 'local_bash', description: 'fresh', parentToolCallId: 'call:fresh', startedAt: Date.now() - 60_000 },
    ],
  })}\n`);
  // Stray crash temp file beside background-tasks.json must not interfere with recovery.
  writeFileSync(`${path}.99999.dead.tmp`, '{"version":1,"tasks":[');

  const liveWriter = spawnWriter(t);
  const starter = spawnWriter(t);
  await Promise.all([liveWriter.ready, starter.ready]);
  await liveWriter.send({ type: 'init', persistPath: path });
  await Promise.all([
    liveWriter.send({ type: 'register', threadId: 'live', taskId: 'brand-new' }),
    starter.send({ type: 'init', persistPath: path }),
  ]);
  await until(() => JSON.stringify(readTaskPairs(path)) === JSON.stringify(['legacy:fresh', 'live:brand-new']));
  await Promise.all([liveWriter.close(), starter.close()]);
  assert.deepEqual(readdirSync(`${path}.locks`), []);
});

test('live lock markers are never evicted by age and yielding removes only the caller marker', t => {
  const path = statePath(t);
  const lockDir = `${path}.locks`;
  mkdirSync(lockDir, { recursive: true });
  const liveMarker = join(lockDir, `${process.pid}-${randomUUID()}.lock`);
  writeFileSync(liveMarker, '');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(liveMarker, hourAgo, hourAgo);

  // Even an hour-old marker owned by a live PID must not be evicted; the contender yields and removes only its own marker.
  assert.deepEqual(withTaskStateLock(path, () => 'should-not-run'), { status: 'contended' });
  assert.deepEqual(readdirSync(lockDir), [liveMarker.split(/[\\/]/).pop()]);

  // Once the live owner removes its marker, acquisition succeeds and cleans up its marker on exit.
  unlinkSync(liveMarker);
  assert.deepEqual(withTaskStateLock(path, () => 'acquired-ok'), { status: 'acquired', value: 'acquired-ok' });
  assert.deepEqual(readdirSync(lockDir), []);
});

const fsError = (code, message = code) => Object.assign(new Error(message), { code });
const drainTimers = (t, steps = 40, stepMs = 1_000) => { for (let i = 0; i < steps; i++) t.mock.timers.tick(stepMs); };

test('transient startup reads retry and populate restart inventory and stale-record GC', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const path = statePath(t);
  const now = Date.now();
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    tasks: [
      { threadId: 'stale', taskId: 'expired-1', taskType: 'local_bash', description: 'old', parentToolCallId: 'call:expired-1', startedAt: now - 10 * 24 * 60 * 60 * 1000 },
      { threadId: 'legacy', taskId: 'old-1', taskType: 'local_bash', description: 'build', parentToolCallId: 'call:old-1', startedAt: now - 1_000 },
    ],
  })}\n`);

  let readFailures = ['EBUSY', 'EPERM'];
  let readAttempts = 0;
  const taskStateFs = {
    readFileSync(filePath, options) {
      if (filePath === path) {
        readAttempts += 1;
        const code = readFailures.shift();
        if (code) throw fsError(code);
      }
      return readFileSync(filePath, options);
    },
  };

  const restarted = tracker(t, { persistPath: path, taskStateFs });
  assert.equal(readAttempts, 1);
  // First retry hits EPERM; second retry succeeds and populates initialRecords + GCs stale record.
  t.mock.timers.tick(10);
  assert.equal(readAttempts, 2);
  t.mock.timers.tick(20);
  assert.equal(readAttempts, 3);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.taskId), ['old-1']);

  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'stale' } }), []);
  const closes = restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'legacy' } });
  assert.equal(closes.length, 1);
  assert.equal(closes[0].kind, 'item.close');
  assert.equal(closes[0].status, 'interrupted');
  assert.equal(closes[0].item.taskStatus, 'stopped');
  assert.equal(closes[0].key.providerItemId, 'task:old-1');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, []);
});

test('resume during transient read reconciles safely and emits closes while preserving subsequent host handoffs', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);

  // Case A: startup read succeeded, then thread/resume hits a transient read while another host takes over.
  const pathA = statePath(t);
  const nowA = Date.now();
  writeFileSync(pathA, `${JSON.stringify({
    version: 1,
    tasks: [
      { threadId: 'thread', taskId: 'old-1', taskType: 'local_bash', description: 'build-1', parentToolCallId: 'call:old-1', startedAt: nowA },
      { threadId: 'thread', taskId: 'old-2', taskType: 'local_bash', description: 'build-2', parentToolCallId: 'call:old-2', startedAt: nowA },
    ],
  })}\n`);

  let blockReadA = false;
  const emittedA = [];
  const restartedA = tracker(t, {
    persistPath: pathA,
    onAsyncDeltas: (threadId, deltas) => emittedA.push({ threadId, deltas }),
    taskStateFs: {
      readFileSync(filePath, options) {
        if (blockReadA && filePath === pathA) throw fsError('EPERM');
        return readFileSync(filePath, options);
      },
    },
  });

  blockReadA = true;
  assert.deepEqual(restartedA.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.equal(emittedA.length, 0);

  // Subsequent host handoff replaces old-2 and adds a new task on the same thread before retry runs.
  const handoffA = tracker(t, { persistPath: pathA });
  handoffA.handleToolEventForThread('thread', command('old-2', { toolCallId: 'call:handoff-2' }));
  handoffA.handleToolEventForThread('thread', command('handoff-new', { toolCallId: 'call:handoff-new' }));

  blockReadA = false;
  t.mock.timers.tick(10);
  assert.equal(emittedA.length, 1);
  assert.equal(emittedA[0].threadId, 'thread');
  assert.deepEqual(emittedA[0].deltas.map(d => [d.key.providerItemId, d.status, d.item.taskStatus]), [
    ['task:old-1', 'interrupted', 'stopped'],
  ]);
  const savedA = JSON.parse(readFileSync(pathA, 'utf8')).tasks;
  assert.deepEqual(savedA.map(task => [task.taskId, task.parentToolCallId]).sort(), [
    ['handoff-new', 'call:handoff-new'],
    ['old-2', 'call:handoff-2'],
  ]);
  // Re-ticking and a later resume must not double-emit or touch handoff records.
  drainTimers(t, 10, 1_000);
  assert.equal(emittedA.length, 1);
  assert.deepEqual(restartedA.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.equal(JSON.parse(readFileSync(pathA, 'utf8')).tasks.length, 2);

  // Case B: startup read itself failed transiently, resume arrives during transient read, and a handoff starts afterward.
  let fakeNow = 10_000;
  t.mock.method(Date, 'now', () => fakeNow);
  const pathB = statePath(t);
  writeFileSync(pathB, `${JSON.stringify({
    version: 1,
    tasks: [
      { threadId: 'thread', taskId: 'pre-restart', taskType: 'local_bash', description: 'legacy', parentToolCallId: 'call:pre', startedAt: fakeNow },
    ],
  })}\n`);

  fakeNow = 20_000;
  let blockReadB = true;
  const emittedB = [];
  const restartedB = tracker(t, {
    persistPath: pathB,
    onAsyncDeltas: (threadId, deltas) => emittedB.push({ threadId, deltas }),
    taskStateFs: {
      readFileSync(filePath, options) {
        if (blockReadB && filePath === pathB) throw fsError('EBUSY');
        return readFileSync(filePath, options);
      },
    },
  });
  assert.deepEqual(restartedB.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.equal(emittedB.length, 0);

  fakeNow = 20_050;
  const handoffB = tracker(t, { persistPath: pathB });
  handoffB.handleToolEventForThread('thread', command('after-handoff', { toolCallId: 'call:after' }));

  blockReadB = false;
  t.mock.timers.tick(10);
  assert.equal(emittedB.length, 1);
  assert.equal(emittedB[0].threadId, 'thread');
  assert.deepEqual(emittedB[0].deltas.map(d => [d.key.providerItemId, d.status, d.item.taskStatus]), [
    ['task:pre-restart', 'interrupted', 'stopped'],
  ]);
  const savedB = JSON.parse(readFileSync(pathB, 'utf8')).tasks;
  assert.deepEqual(savedB.map(task => [task.taskId, task.parentToolCallId]), [
    ['after-handoff', 'call:after'],
  ]);
});

test('fresh same-millisecond replacement wins against old while delayed add retry preserves already-saved replacement', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  t.mock.method(Date, 'now', () => 12345);
  const path = statePath(t);

  // 1. Fresh replacement with a different parentToolCallId in the same ms overwrites the old saved record.
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('thread', command('same', { toolCallId: 'call:old' }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks[0].parentToolCallId, 'call:old');

  const second = tracker(t, { persistPath: path });
  second.handleToolEventForThread('thread', command('same', { toolCallId: 'call:fresh-replacement' }));
  assert.deepEqual(
    JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => [task.taskId, task.parentToolCallId]),
    [['same', 'call:fresh-replacement']],
  );

  // 2. A delayed add retry (queued after a transient write failure) preserves an already-saved same-ms replacement.
  let failRenameOnce = true;
  const third = tracker(t, {
    persistPath: path,
    taskStateFs: {
      renameSync(from, to) {
        if (failRenameOnce && to === path) {
          failRenameOnce = false;
          throw fsError('EBUSY');
        }
        return renameSync(from, to);
      },
    },
  });
  third.handleToolEventForThread('thread', command('same', { toolCallId: 'call:delayed-add' }));
  // Another tracker saves a fresh replacement at the same millisecond before third's retry runs.
  const fourth = tracker(t, { persistPath: path });
  fourth.handleToolEventForThread('thread', command('same', { toolCallId: 'call:saved-replacement' }));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks[0].parentToolCallId, 'call:saved-replacement');

  // When third's scheduled retry flushes its delayed add, it must preserve the already-saved replacement.
  t.mock.timers.tick(10);
  assert.deepEqual(
    JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => [task.taskId, task.parentToolCallId]),
    [['same', 'call:saved-replacement']],
  );
});

test('Windows transient marker I/O uses bounded exponential backoff for lock acquisition and marker cleanup', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const path = statePath(t);
  const lockDir = `${path}.locks`;

  // 1. withTaskStateLock classifies Windows transient marker I/O as 'transient' and cleans up created markers.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    assert.deepEqual(
      withTaskStateLock(path, () => 'never', { mkdirSync() { throw fsError(code); } }),
      { status: 'transient' },
    );
    assert.deepEqual(
      withTaskStateLock(path, () => 'never', { openSync() { throw fsError(code); } }),
      { status: 'transient' },
    );
    assert.deepEqual(
      withTaskStateLock(path, () => 'never', {
        closeSync(fd) {
          closeSync(fd);
          throw fsError(code);
        },
      }),
      { status: 'transient' },
    );
    assert.deepEqual(readdirSync(lockDir), []);
    assert.deepEqual(
      withTaskStateLock(path, () => 'never', { readdirSync() { throw fsError(code); } }),
      { status: 'transient' },
    );
    assert.deepEqual(readdirSync(lockDir), []);
  }
  assert.deepEqual(
    withTaskStateLock(path, () => 'never', { mkdirSync() { throw fsError('EIO'); } }),
    { status: 'error' },
  );

  // 2. Marker unlink retries transiently with exponential backoff, succeeds when cleared, and bounds permanent errors.
  let unlinkFailures = 3;
  let unlinkAttempts = 0;
  assert.deepEqual(
    withTaskStateLock(path, () => 'ok', {
      unlinkSync(target) {
        unlinkAttempts += 1;
        if (unlinkFailures > 0) {
          unlinkFailures -= 1;
          throw fsError('EPERM');
        }
        return unlinkSync(target);
      },
    }),
    { status: 'acquired', value: 'ok' },
  );
  assert.equal(unlinkAttempts, 1);
  assert.equal(readdirSync(lockDir).length, 1);
  t.mock.timers.tick(9);
  assert.equal(unlinkAttempts, 1);
  t.mock.timers.tick(1); // 10ms
  assert.equal(unlinkAttempts, 2);
  t.mock.timers.tick(19);
  assert.equal(unlinkAttempts, 2);
  t.mock.timers.tick(1); // 20ms
  assert.equal(unlinkAttempts, 3);
  t.mock.timers.tick(40); // 40ms
  assert.equal(unlinkAttempts, 4);
  assert.deepEqual(readdirSync(lockDir), []);

  let permanentUnlinkAttempts = 0;
  let permanentMarker = '';
  assert.deepEqual(
    withTaskStateLock(path, () => 'ok', {
      unlinkSync(target) {
        permanentMarker = String(target);
        permanentUnlinkAttempts += 1;
        throw fsError('EACCES');
      },
    }),
    { status: 'acquired', value: 'ok' },
  );
  drainTimers(t);
  assert.equal(permanentUnlinkAttempts, 21, 'marker unlink retries must be bounded at TRANSIENT_IO_MAX_RETRIES');
  unlinkSync(permanentMarker);

  // 3. Tracker persistence retries on Windows transient marker EPERM/EACCES and bounds permanent failures.
  let markerFailures = ['EPERM', 'EACCES', 'EBUSY'];
  let openAttempts = 0;
  const recovering = tracker(t, {
    persistPath: path,
    taskStateFs: {
      openSync(target, flags) {
        if (String(target).endsWith('.lock')) {
          openAttempts += 1;
          const code = markerFailures.shift();
          if (code) throw fsError(code);
        }
        return openSync(target, flags);
      },
    },
  });
  openAttempts = 0;
  markerFailures = ['EPERM', 'EACCES', 'EBUSY'];
  recovering.handleToolEventForThread('win', command('marker-retry'));
  assert.equal(openAttempts, 1);
  assert.equal(existsSync(path), false);
  t.mock.timers.tick(10); // attempt 2 (EACCES)
  t.mock.timers.tick(20); // attempt 3 (EBUSY)
  t.mock.timers.tick(40); // attempt 4 (succeeds)
  assert.equal(openAttempts, 4);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.taskId), ['marker-retry']);

  const boundedPath = statePath(t);
  let boundedOpenAttempts = 0;
  const bounded = tracker(t, {
    persistPath: boundedPath,
    taskStateFs: {
      openSync(target, flags) {
        if (String(target).endsWith('.lock')) {
          boundedOpenAttempts += 1;
          throw fsError('EPERM');
        }
        return openSync(target, flags);
      },
    },
  });
  boundedOpenAttempts = 0;
  bounded.handleToolEventForThread('win', command('permanent-eperm'));
  drainTimers(t);
  assert.equal(boundedOpenAttempts, 21, 'transient marker retries must stop after TRANSIENT_IO_MAX_RETRIES');
  assert.equal(existsSync(boundedPath), false);
});

test('dispose guards persisted state against late calls and cancels pending persistence timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const path = statePath(t);

  // Case A: active tracker disposed preserves persisted records even if late calls arrive.
  const first = tracker(t, { persistPath: path });
  first.handleToolEventForThread('thread', command('survives'));
  first.dispose();
  assert.deepEqual(first.clearThread('thread', true), []);
  assert.deepEqual(first.handleInboundRequest({ method: 'thread/stop', params: { threadId: 'thread' } }), []);
  assert.deepEqual(first.handleInboundRequest({ method: 'thread/discard', params: { threadId: 'thread' } }), []);
  assert.deepEqual(first.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.deepEqual(first.handleInboundRequest({ method: 'turn/start', params: { threadId: 'thread' } }), []);
  assert.deepEqual(first.handleToolEventForThread('thread', command('after-dispose')), []);
  assert.deepEqual(first.inspectTextForCompletions('thread', 'Task id "survives" failed'), []);
  const orphanLine = JSON.stringify({
    method: 'thread/delta',
    params: { threadId: 'thread', deltas: [{ kind: 'item.close', status: 'completed', key: { providerItemId: 'call:orphan' } }] },
  });
  assert.deepEqual(first.processStdoutLine(orphanLine), [orphanLine]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.taskId), ['survives']);

  // Case B: restarted tracker disposed before resume leaves persisted records intact for the next host.
  const restarted = tracker(t, { persistPath: path });
  restarted.dispose();
  assert.deepEqual(restarted.clearThread('thread'), []);
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  assert.deepEqual(restarted.handleInboundRequest({ method: 'thread/stop', params: { threadId: 'thread' } }), []);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.taskId), ['survives']);

  // Case C: pending retry timers (write + deferred reconciliation) are cancelled on dispose and never fire.
  let blockRead = true;
  let readsAfterDispose = 0;
  let disposedFlag = false;
  const asyncEvents = [];
  const pendingTracker = tracker(t, {
    persistPath: path,
    onAsyncDeltas: (threadId, deltas) => asyncEvents.push({ threadId, deltas }),
    taskStateFs: {
      readFileSync(filePath, options) {
        if (disposedFlag) readsAfterDispose += 1;
        if (blockRead && filePath === path) throw fsError('EBUSY');
        return readFileSync(filePath, options);
      },
    },
  });
  assert.deepEqual(pendingTracker.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }), []);
  pendingTracker.handleToolEventForThread('other', command('queued-add'));
  pendingTracker.dispose();
  disposedFlag = true;
  blockRead = false;
  drainTimers(t);
  assert.equal(readsAfterDispose, 0);
  assert.equal(asyncEvents.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks.map(task => task.taskId), ['survives']);

  // A subsequent healthy host still reconciles the preserved record cleanly.
  const nextHost = tracker(t, { persistPath: path });
  assert.deepEqual(
    nextHost.handleInboundRequest({ method: 'thread/resume', params: { threadId: 'thread' } }).map(d => d.key.providerItemId),
    ['task:survives'],
  );
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, []);
});

// Silent turn detection: a turn that ends with a failed command with empty output and no
// agent text at all is surfaced with a synthetic agent-visible message (issue #16).
const failedEmptyCommand = (extra = {}) => ({ kind: 'item.close', status: 'failed', key: { providerItemId: 'call:failed-cmd' }, item: { type: 'command', command: 'rebuild', cwd: '' }, exitCode: 1, ...extra });
const boundary = (status = 'completed') => ({ kind: 'turn.boundary', status });
const visibleAgentText = text => ({ kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text });
const injectedMessage = deltas => deltas.find(d => d.kind === 'item.textClose');
test('failed empty-output command with no agent text injects a visible message before the boundary', t => {
  const tr = tracker(t);
  const deltas = stdout(tr, 't', failedEmptyCommand(), boundary());
  assert.deepEqual(deltas.map(d => d.kind), ['item.close', 'item.textDelta', 'item.textClose', 'turn.boundary']);
  const open = deltas[1];
  const message = injectedMessage(deltas);
  assert.equal(open.channel, 'agentMessage'); assert.deepEqual(open.key, { channel: 'assistant' });
  assert.equal(open.text, message.text); assert.equal(message.channel, 'agentMessage');
  assert.match(message.text, /ended this turn without a response/);
  assert.match(message.text, /reload|restart/i);
});
test('no injection for turns without empty-output failures or with agent text', t => {
  const tr = tracker(t);
  assert.deepEqual(stdout(tr, 't', boundary()), [boundary()]);
  const noisyFailure = failedEmptyCommand({ aggregatedOutput: 'permission denied', resultText: 'permission denied' });
  assert.deepEqual(stdout(tr, 't', noisyFailure, boundary()), [noisyFailure, boundary()]);
  const completed = { ...failedEmptyCommand(), status: 'completed', exitCode: 0 };
  assert.deepEqual(stdout(tr, 't', completed, boundary()), [completed, boundary()]);
  const textTurn = [failedEmptyCommand(), visibleAgentText('I hit an error'), boundary()];
  assert.deepEqual(stdout(tr, 't', ...textTurn), textTurn);
  // reasoning-only text is not visible agent output, so it is still a silent give-up
  const thinking = { kind: 'item.textDelta', key: { channel: 'thought' }, channel: 'reasoningText', text: 'thinking only' };
  const injected = injectedMessage(stdout(tr, 't', failedEmptyCommand(), thinking, boundary()));
  assert.ok(injected); assert.match(injected.text, /without a response/);
});
test('escalation after consecutive silent turns and reset on healthy turns', t => {
  const tr = tracker(t);
  const first = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.match(first.text, /without a response|reload|restart/i);
  assert.doesNotMatch(first.text, /broken in this session/);
  const second = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.match(second.text, /broken in this session/);
  assert.match(second.text, /restart the thread runtime/i);
  const third = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.match(third.text, /3 consecutive turns/);
  // a turn with a healthy command (no failure) resets the streak
  assert.equal(stdout(tr, 't', boundary()).length, 1);
  const afterReset = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.doesNotMatch(afterReset.text, /broken in this session/);
});
test('interrupted boundaries are never injected and leave the streak intact', t => {
  const tr = tracker(t);
  assert.deepEqual(stdout(tr, 't', failedEmptyCommand(), boundary('interrupted')), [failedEmptyCommand(), boundary('interrupted')]);
  const next = injectedMessage(stdout(tr, 't', failedEmptyCommand(), boundary()));
  assert.doesNotMatch(next.text, /broken in this session/);
});
test('recorded failed run_command events with empty output also count as the silent signature', t => {
  const tr = tracker(t);
  tr.recordToolEvent({ toolCallId: 'call:empty', title: 'run_command', status: 'failed', content: [{ type: 'text', text: '   ' }] });
  assert.equal(stdout(tr, 't', { kind: 'item.close', key: { providerItemId: 'call:empty' } }).length, 1);
  const message = injectedMessage(stdout(tr, 't', boundary()));
  assert.ok(message); assert.match(message.text, /without a response/);
});
test('silent-turn tracking is isolated per thread', t => {
  const tr = tracker(t);
  stdout(tr, 'a', failedEmptyCommand(), boundary());
  const bFirst = injectedMessage(stdout(tr, 'b', failedEmptyCommand(), boundary()));
  assert.doesNotMatch(bFirst.text, /broken in this session/);
  const aSecond = injectedMessage(stdout(tr, 'a', failedEmptyCommand(), boundary()));
  assert.match(aSecond.text, /broken in this session/);
});
