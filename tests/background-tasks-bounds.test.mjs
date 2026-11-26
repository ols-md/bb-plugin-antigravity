import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createBackgroundTaskTracker,
  DEFAULT_MAX_RETAINED_TOOL_OUTPUT_CHARS,
  DEFAULT_MAX_TRANSCRIPT_READ_BYTES,
} from '../background-tasks.ts';

function tracker(t, options = {}) {
  const async = [];
  const value = createBackgroundTaskTracker({
    pollIntervalMs: 0,
    onAsyncDeltas: (threadId, deltas) => async.push({ threadId, deltas }),
    ...options,
  });
  t.after(() => value.dispose());
  return Object.assign(value, { async });
}

function createTranscriptFixture(t, prefix = 'bg-bounds-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = join(dir, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  const transcript = join(logs, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const logFor = id => join(dir, '.system_generated', 'tasks', `${id}.log`);
  return { dir, transcript, logFor };
}

async function until(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), 'condition not reached in time');
}

const command = (id, logPath, extra = {}) => ({
  toolCallId: `call:${id}`,
  title: 'run_command',
  status: 'completed',
  rawInput: { CommandLine: 'npm test', toolSummary: `Run ${id}` },
  content: [{ type: 'text', text: `Tool is running as a background task with task id: ${id}\nTask Description: Run ${id}\n${logPath ? `Task logs are available at: ${logPath}\n` : ''}` }],
  ...extra,
});

function line(tr, threadId, ...deltas) {
  const out = tr.processStdoutLine(JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId, deltas } }));
  return out.flatMap(text => JSON.parse(text).params.deltas);
}

test('bounded transcript polling preserves UTF-8 framing across chunk boundaries', async t => {
  const { transcript, logFor } = createTranscriptFixture(t, 'bg-utf8-');
  // Deliberately tiny chunk size so 2-, 3-, and 4-byte UTF-8 sequences split across read boundaries.
  const tr = tracker(t, { pollIntervalMs: 10, maxTranscriptReadBytes: 24 });
  tr.handleToolEventForThread('utf8', command('conv/utf8-task', logFor('utf8-task')));

  const emoji = '🎉🚀';
  const cjk = '日本語テスト';
  const accented = 'café—naïve';
  const record = JSON.stringify({
    content: `${accented} ${emoji} ${cjk} Task id "conv/utf8-task" finished with result: ${emoji} ${cjk} ok`,
  });
  // Verify the encoded JSON line actually crosses multiple 24-byte chunk boundaries on multi-byte sequences.
  assert.ok(Buffer.byteLength(record, 'utf8') > 96);
  appendFileSync(transcript, `${record}\n`);

  await until(() => tr.getActiveTasks('utf8').length === 0);
  const close = tr.async.flatMap(entry => entry.deltas).find(d => d.kind === 'item.close');
  assert.ok(close);
  assert.equal(close.status, 'completed');
  assert.ok(!close.item.summary.includes('\uFFFD'), `replacement char found in summary: ${close.item.summary}`);
  assert.match(close.item.summary, /🎉🚀 日本語テスト ok/);
});

test('oversized single transcript lines stay bounded and still recover embedded and subsequent completions', async t => {
  const { transcript, logFor } = createTranscriptFixture(t, 'bg-oversized-');
  const tr = tracker(t, {
    pollIntervalMs: 10,
    maxTranscriptReadBytes: 2048,
    maxTranscriptLineChars: 4096,
    maxRetainedToolOutputChars: 512,
  });
  tr.handleToolEventForThread('t', command('conv/in-line', logFor('in-line')));
  tr.handleToolEventForThread('t', command('conv/after-line', logFor('after-line')));

  // Build one huge JSONL line (~128 KiB) with a completion placed across an internal window cut,
  // followed by a normal JSONL line carrying a second completion.
  const paddingA = 'a'.repeat(50_000);
  const embedded = 'Task id "conv/in-line" finished with result: Command exited with code 7';
  const paddingB = 'b'.repeat(50_000);
  const giantLine = JSON.stringify({ content: `${paddingA} ${embedded} ${paddingB}` });
  const followUpLine = JSON.stringify({ content: 'Task id "conv/after-line" finished with result: all green' });
  appendFileSync(transcript, `${giantLine}\n${followUpLine}\n`);

  await until(() => tr.getActiveTasks('t').length === 0);
  const closes = tr.async.flatMap(entry => entry.deltas).filter(d => d.kind === 'item.close');
  const byId = new Map(closes.map(d => [d.item.familyId, d]));
  assert.equal(byId.get('conv/in-line')?.status, 'failed');
  assert.ok((byId.get('conv/in-line')?.item.summary?.length ?? 0) <= 512);
  assert.equal(byId.get('conv/after-line')?.status, 'completed');
  assert.equal(byId.get('conv/after-line')?.item.summary, 'all green');
});

test('bounded transcript polling maintains thread isolation when one thread has a large backlog', async t => {
  const heavy = createTranscriptFixture(t, 'bg-iso-heavy-');
  const fast = createTranscriptFixture(t, 'bg-iso-fast-');
  const tr = tracker(t, { pollIntervalMs: 10, maxTranscriptReadBytes: 32 * 1024 });

  tr.handleToolEventForThread('heavy', command('conv/heavy-task', heavy.logFor('heavy-task')));
  tr.handleToolEventForThread('fast', command('conv/fast-task', fast.logFor('fast-task')));

  // Append 4 MiB of noise + late completion to heavy, and one tiny completion to fast.
  const noiseLine = `${JSON.stringify({ content: 'x'.repeat(4000) })}\n`;
  const fd = openSync(heavy.transcript, 'a');
  try {
    const block = Buffer.from(noiseLine.repeat(64));
    for (let i = 0; i < 16; i += 1) writeSync(fd, block);
    writeSync(fd, `${JSON.stringify({ content: 'Task id "conv/heavy-task" finished with result: Command exited with code 0' })}\n`);
  } finally {
    closeSync(fd);
  }
  appendFileSync(fast.transcript, `${JSON.stringify({ content: 'Task id "conv/fast-task" finished with result: quick ok' })}\n`);

  const settlementOrder = [];
  const origPush = tr.async.push.bind(tr.async);
  tr.async.push = (...items) => {
    for (const item of items) {
      for (const d of item.deltas) {
        if (d.kind === 'item.close') settlementOrder.push(`${item.threadId}:${d.item.familyId}`);
      }
    }
    return origPush(...items);
  };

  await until(() => tr.getActiveTasks('heavy').length === 0 && tr.getActiveTasks('fast').length === 0);
  // Fast thread settles on the first poll slice instead of waiting behind heavy's entire 4 MiB backlog.
  assert.equal(settlementOrder[0], 'fast:conv/fast-task');
  assert.equal(settlementOrder[1], 'heavy:conv/heavy-task');
});

test('long tool-heavy sessions bound retained tool output while preserving PR 31 orphan tracking', async t => {
  const tr = tracker(t, {
    holdSettleGraceMs: 25,
    maxRetainedToolOutputChars: 1024,
    maxRetainedToolsPerThread: 16,
    maxPendingToolEvents: 32,
  });

  // Start a PR 31 orphan run_command: in_progress, then force-closed at turn end.
  const orphanId = 'call:orphan-e2e';
  line(tr, 't', {
    kind: 'item.open',
    key: { providerItemId: orphanId },
    item: { type: 'command', command: 'npm run e2e', cwd: '' },
    noTurnFallback: {
      raw: {
        params: {
          update: {
            toolCallId: orphanId,
            title: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'npm run e2e', toolSummary: 'Run e2e suite' },
          },
        },
      },
    },
  });
  const flushed = line(
    tr,
    't',
    { kind: 'item.close', status: 'completed', key: { providerItemId: orphanId }, item: { type: 'command', command: 'npm run e2e', cwd: '' } },
    { kind: 'turn.boundary', status: 'completed' },
  );
  assert.ok(!flushed.some(d => d.kind === 'turn.boundary'), 'orphan command holds turn open');
  assert.equal(tr.isHoldingTurn('t'), true);

  // Flood the same thread with 200 completed large-output tool calls AND 40 leaked in_progress tool calls
  // (more than maxRetainedToolsPerThread) plus unconsumed pending events.
  const hugePayload = 'L'.repeat(64 * 1024);
  for (let i = 0; i < 200; i += 1) {
    const id = `call:read-${i}`;
    tr.recordToolEvent({
      toolCallId: id,
      title: 'write_file',
      status: 'in_progress',
      rawInput: { Path: `/tmp/file-${i}.txt`, Content: hugePayload },
    });
    line(tr, 't', { kind: 'item.open', key: { providerItemId: id } });
    tr.recordToolEvent({
      toolCallId: id,
      title: 'write_file',
      status: 'completed',
      content: [{ type: 'text', text: hugePayload }],
    });
    line(tr, 't', { kind: 'item.close', status: 'completed', key: { providerItemId: id } });
  }
  for (let i = 0; i < 40; i += 1) {
    const id = `call:leaked-${i}`;
    line(tr, 't', {
      kind: 'item.open',
      key: { providerItemId: id },
      noTurnFallback: {
        raw: {
          params: {
            update: {
              toolCallId: id,
              title: 'read_file',
              status: 'in_progress',
              rawInput: { Path: `/tmp/leaked-${i}.txt` },
              content: hugePayload,
            },
          },
        },
      },
    });
  }
  for (let i = 0; i < 60; i += 1) {
    tr.recordToolEvent({
      toolCallId: `call:unconsumed-${i}`,
      title: 'read_file',
      status: 'completed',
      content: hugePayload,
    });
  }

  // The late completion for the PR 31 orphan arrives with huge output: head + tail must survive,
  // status must reflect failure, summary must be bounded, and the turn must settle.
  const lateOutput = `Command exited with code 2\n${'M'.repeat(40_000)}\nFINAL_TAIL_MARKER`;
  const settled = line(tr, 't', {
    kind: 'item.close',
    status: 'completed',
    key: { providerItemId: orphanId },
    item: { type: 'command' },
    noTurnFallback: {
      raw: {
        params: {
          update: {
            toolCallId: orphanId,
            status: 'completed',
            content: [{ type: 'text', text: lateOutput }],
          },
        },
      },
    },
  });
  const close = settled.find(d => d.item?.type === 'backgroundTask' && d.kind === 'item.close');
  assert.ok(close, 'orphan command must still settle after heavy tool traffic');
  assert.equal(close.status, 'failed');
  assert.ok(close.item.summary.length <= 1024);
  assert.match(close.item.summary, /Command exited with code 2/);
  assert.match(close.item.summary, /FINAL_TAIL_MARKER/);
  assert.equal(tr.getActiveTasks('t').length, 0);

  await until(() => !tr.isHoldingTurn('t'));
  assert.ok(tr.async.flatMap(entry => entry.deltas).some(d => d.kind === 'turn.boundary'));
});

test('stream completion buffers stay bounded on large streamed output and still settle split completions', t => {
  const tr = tracker(t, { maxStreamBufferChars: 2048, maxRetainedToolOutputChars: 512 });
  tr.handleToolEventForThread('t', command('conv/stream-task', undefined));
  // Stream 100 KiB of noise followed by a completion split across two deltas.
  const noise = 'z'.repeat(1500);
  for (let i = 0; i < 64; i += 1) {
    line(tr, 't', { kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text: noise });
  }
  line(tr, 't', { kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text: 'Task id "conv/stream-' });
  line(tr, 't', { kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text: 'task" finished with result: Command exited with code 4' });
  const flushed = line(tr, 't', { kind: 'item.textClose', key: { channel: 'assistant' }, channel: 'agentMessage', text: '' });
  const close = flushed.find(d => d.item?.type === 'backgroundTask' && d.kind === 'item.close');
  assert.ok(close);
  assert.equal(close.status, 'failed');
  assert.equal(tr.getActiveTasks('t').length, 0);
});

test('truncated manage_task and manage_subagents list output never falsely settles a running middle entry, while authoritative fallback lists process completely', t => {
  const tr = tracker(t, { maxRetainedToolOutputChars: 512 });
  tr.handleToolEventForThread('t', command('conv/middle-task', undefined));
  tr.handleToolEventForThread('t', command('conv/gone-task', undefined));
  tr.handleToolEventForThread('t', {
    toolCallId: 'call:agent-mid',
    title: 'invoke_subagent',
    status: 'completed',
    rawInput: { Role: 'Research' },
    rawOutput: { conversationId: 'agent-middle' },
  });

  const padRow = i => `| 12:00:00 | conv/pad-${i} | run_command | ${'x'.repeat(60)} |`;
  const bigTaskList = [
    '| Start Time | Task ID | Tool | Description |',
    ...Array.from({ length: 12 }, (_, i) => padRow(i)),
    '| 12:00:01 | conv/middle-task | run_command | still running |',
    ...Array.from({ length: 12 }, (_, i) => padRow(i + 100)),
  ].join('\n');
  assert.ok(bigTaskList.length > 512);

  // 1. When queued through recordToolEvent and truncated, absence from the truncated middle must NOT settle middle-task.
  tr.recordToolEvent({
    toolCallId: 'call:list-1',
    title: 'manage_task',
    status: 'completed',
    rawInput: { Action: 'list' },
    content: bigTaskList,
  });
  const fromPending = line(tr, 't', { kind: 'item.close', key: { providerItemId: 'call:list-1' } });
  assert.equal(fromPending.filter(d => d.item?.type === 'backgroundTask').length, 0);
  assert.deepEqual(
    tr.getActiveTasks('t').map(task => task.taskId).sort(),
    ['agent-middle', 'conv/gone-task', 'conv/middle-task'],
  );

  // 2. Truncated manage_subagents list must not falsely settle a running subagent in the middle.
  const bigSubagentList = [
    ...Array.from({ length: 15 }, (_, i) => `agent-pad-${i} running ${'y'.repeat(40)}`),
    'agent-middle running',
    ...Array.from({ length: 15 }, (_, i) => `agent-tail-${i} running ${'z'.repeat(40)}`),
  ].join('\n');
  tr.recordToolEvent({
    toolCallId: 'call:sub-list-1',
    title: 'manage_subagents',
    status: 'completed',
    rawInput: { Action: 'list' },
    content: bigSubagentList,
  });
  const subFromPending = line(tr, 't', { kind: 'item.close', key: { providerItemId: 'call:sub-list-1' } });
  assert.equal(subFromPending.filter(d => d.item?.type === 'backgroundTask').length, 0);
  assert.ok(tr.getActiveTasks('t').some(task => task.taskId === 'agent-middle'));

  // 3. Complete authoritative fallback event is processed transiently without truncation:
  //    middle-task stays active, gone-task settles, and emitted summary stays bounded.
  const fromFallback = line(tr, 't', {
    kind: 'item.close',
    status: 'completed',
    key: { providerItemId: 'call:list-2' },
    noTurnFallback: {
      raw: {
        params: {
          update: {
            toolCallId: 'call:list-2',
            title: 'manage_task',
            status: 'completed',
            rawInput: { Action: 'list' },
            content: bigTaskList,
          },
        },
      },
    },
  });
  const closed = fromFallback.filter(d => d.item?.type === 'backgroundTask' && d.kind === 'item.close');
  assert.deepEqual(closed.map(d => d.item.familyId), ['conv/gone-task']);
  assert.ok(closed[0].item.summary.length <= 512);
  assert.deepEqual(
    tr.getActiveTasks('t').map(task => task.taskId).sort(),
    ['agent-middle', 'conv/middle-task'],
  );
});

test('synthetic large transcript (16 MiB) stays responsive, bounds memory growth, and settles late completion', async t => {
  const { transcript, logFor } = createTranscriptFixture(t, 'bg-large-');
  const tr = tracker(t, {
    pollIntervalMs: 10,
    maxTranscriptReadBytes: DEFAULT_MAX_TRANSCRIPT_READ_BYTES,
    maxRetainedToolOutputChars: DEFAULT_MAX_RETAINED_TOOL_OUTPUT_CHARS,
  });
  tr.handleToolEventForThread('large', command('conv/late-16m', logFor('late-16m')));

  // Write ~16 MiB of synthetic JSONL records followed by a late completion line at EOF.
  const targetBytes = 16 * 1024 * 1024;
  const unitLine = `${JSON.stringify({ content: `synthetic log entry ${'0123456789abcdef'.repeat(250)}` })}\n`;
  const batch = Buffer.from(unitLine.repeat(64));
  const fd = openSync(transcript, 'a');
  let written = 0;
  try {
    while (written < targetBytes) {
      writeSync(fd, batch);
      written += batch.length;
    }
    writeSync(fd, `${JSON.stringify({ content: 'Task id "conv/late-16m" finished with result: Command exited with code 0\nsynthetic ok' })}\n`);
  } finally {
    closeSync(fd);
  }

  const loopMonitor = monitorEventLoopDelay({ resolution: 10 });
  loopMonitor.enable();
  t.after(() => loopMonitor.disable());

  const startHeap = process.memoryUsage().heapUsed;
  const startArrayBuffers = process.memoryUsage().arrayBuffers;
  let peakHeapDelta = 0;
  let peakArrayBuffersDelta = 0;
  const sampleTimer = setInterval(() => {
    const usage = process.memoryUsage();
    peakHeapDelta = Math.max(peakHeapDelta, usage.heapUsed - startHeap);
    peakArrayBuffersDelta = Math.max(peakArrayBuffersDelta, usage.arrayBuffers - startArrayBuffers);
  }, 5);
  t.after(() => clearInterval(sampleTimer));

  const t0 = performance.now();
  await until(() => tr.getActiveTasks('large').length === 0, 15000);
  const elapsedMs = performance.now() - t0;
  clearInterval(sampleTimer);
  loopMonitor.disable();

  const close = tr.async.flatMap(entry => entry.deltas).find(d => d.kind === 'item.close');
  assert.ok(close, 'late completion at end of 16 MiB transcript must settle');
  assert.equal(close.status, 'completed');
  assert.match(close.item.summary, /synthetic ok/);

  // Buffer allocation must not spike anywhere near the 16 MiB transcript size.
  assert.ok(
    peakArrayBuffersDelta < 4 * 1024 * 1024,
    `expected bounded arrayBuffers delta (<4 MiB), got ${(peakArrayBuffersDelta / (1024 * 1024)).toFixed(2)} MiB`,
  );
  // Sanity check that catch-up completed promptly rather than stalling across dozens of 500ms intervals.
  assert.ok(elapsedMs < 10_000, `expected prompt catch-up, took ${elapsedMs.toFixed(1)} ms`);
  t.diagnostic(
    `16 MiB synthetic transcript settled in ${elapsedMs.toFixed(1)} ms | ` +
    `eventLoopDelay p99=${(loopMonitor.percentile(99) / 1e6).toFixed(2)} ms max=${(loopMonitor.max / 1e6).toFixed(2)} ms | ` +
    `peakHeapDelta=${(peakHeapDelta / (1024 * 1024)).toFixed(2)} MiB peakArrayBuffersDelta=${(peakArrayBuffersDelta / (1024 * 1024)).toFixed(2)} MiB`,
  );
});
