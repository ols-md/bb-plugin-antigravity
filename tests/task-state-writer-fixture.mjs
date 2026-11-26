import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createBackgroundTaskTracker, withTaskStateLock } from '../background-tasks.ts';

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const command = (id, extra = {}) => ({
  toolCallId: extra.toolCallId ?? `call:${id}`,
  title: 'run_command',
  status: 'completed',
  content: [{ type: 'text', text: `Tool is running as a background task with task id: ${id}\nTask Description: ${extra.description ?? 'build'}\n` }],
});

let tracker = null;

process.on('message', msg => {
  if (!msg || typeof msg !== 'object') return;
  try {
    if (msg.type === 'init') {
      tracker?.dispose();
      tracker = createBackgroundTaskTracker({
        pollIntervalMs: 0,
        persistPath: msg.persistPath,
        ...(typeof msg.taskStateMaxAgeMs === 'number' ? { taskStateMaxAgeMs: msg.taskStateMaxAgeMs } : {}),
      });
      process.send?.({ type: 'ack', id: msg.id, pid: process.pid });
      return;
    }
    if (msg.type === 'register') {
      tracker.handleToolEventForThread(msg.threadId, command(msg.taskId, msg));
      process.send?.({ type: 'ack', id: msg.id });
      return;
    }
    if (msg.type === 'settle') {
      tracker.inspectTextForCompletions(msg.threadId, `Task id "${msg.taskId}" finished with result: success`);
      process.send?.({ type: 'ack', id: msg.id });
      return;
    }
    if (msg.type === 'clear') {
      tracker.clearThread(msg.threadId);
      process.send?.({ type: 'ack', id: msg.id });
      return;
    }
    if (msg.type === 'resume') {
      const deltas = tracker.handleInboundRequest({ method: 'thread/resume', params: { threadId: msg.threadId } });
      process.send?.({ type: 'ack', id: msg.id, deltas });
      return;
    }
    if (msg.type === 'holdLockAndWrite') {
      const result = withTaskStateLock(msg.persistPath, () => {
        let tasks = [];
        try {
          const parsed = JSON.parse(readFileSync(msg.persistPath, 'utf8'));
          if (parsed?.version === 1 && Array.isArray(parsed.tasks)) tasks = parsed.tasks;
        } catch { /* missing */ }
        process.send?.({ type: 'locked', id: msg.id, pid: process.pid });
        Atomics.wait(SLEEP, 0, 0, msg.holdMs ?? 220);
        if (msg.write !== false) {
          tasks.push({
            threadId: msg.threadId,
            taskId: msg.taskId,
            taskType: 'local_bash',
            description: 'held-write',
            parentToolCallId: `call:${msg.taskId}`,
            startedAt: Date.now(),
          });
          const temp = `${msg.persistPath}.${process.pid}.fixture.tmp`;
          writeFileSync(temp, `${JSON.stringify({ version: 1, tasks })}\n`);
          renameSync(temp, msg.persistPath);
        }
        return true;
      });
      process.send?.({ type: 'ack', id: msg.id, status: result.status });
      return;
    }
    if (msg.type === 'exit') {
      tracker?.dispose();
      process.exit(0);
    }
  } catch (error) {
    process.send?.({ type: 'error', id: msg.id, message: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});

process.send?.({ type: 'online', pid: process.pid });
