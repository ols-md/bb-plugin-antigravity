import { openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { inferAntigravityToolName } from './dialect.ts';

export interface RecordedToolEvent {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: unknown;
}
export interface BackgroundTask {
  taskId: string;
  taskType: 'local_bash' | 'local_subagent';
  description: string;
  parentToolCallId: string;
  outputFile?: string;
  transcriptPath?: string;
}
export interface BackgroundTaskDelta {
  kind: 'item.open' | 'item.close';
  attach?: 'currentOrLast';
  key: { providerItemId: string; parentRef?: string };
  status?: 'completed' | 'failed' | 'interrupted';
  item: Record<string, unknown>;
  presentation: Record<string, unknown>;
}
export function normalizeFileUri(value: string): string {
  return value.trim().replace(/^file:\/\/\/([A-Za-z]:\/)/i, '$1').replace(/^file:\/\/\//i, '/');
}
export function deriveTranscriptPathFromLogFile(outputFile: string): string | null {
  const path = normalizeFileUri(outputFile).replace(/\\/g, '/');
  return /\/\.system_generated\/tasks\/[^/]+$/.test(path)
    ? path.replace(/\.system_generated\/tasks\/[^/]+$/, '.system_generated/logs/transcript.jsonl') : null;
}
export function extractToolOutputText(event: RecordedToolEvent): string {
  function extract(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(extract).filter(Boolean).join('\n');
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const parts = ['text', 'content', 'output'].filter(key => key in obj).map(key => extract(obj[key]));
      return parts.length ? parts.join('\n') : JSON.stringify(value);
    }
    return '';
  }
  return [extract(event.content), extract(event.rawOutput)].filter(Boolean).join('\n');
}
const first = (...values: unknown[]): string => values.find(v => typeof v === 'string' && v.trim())?.toString().trim() ?? '';
function containsTaskToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_/-])${escaped}(?![A-Za-z0-9_/-])`).test(text);
}

function mergeToolEvent(previous: RecordedToolEvent | undefined, event: RecordedToolEvent): RecordedToolEvent {
  return {
    ...previous, ...event,
    title: event.title ?? previous?.title,
    kind: event.kind ?? previous?.kind,
    status: event.status ?? previous?.status,
    rawInput: previous?.rawInput && event.rawInput ? { ...previous.rawInput, ...event.rawInput } : event.rawInput ?? previous?.rawInput,
    rawOutput: event.rawOutput ?? previous?.rawOutput,
    content: event.content ?? previous?.content,
  };
}

export function createBackgroundTaskTracker(options: {
  pollIntervalMs?: number;
  onAsyncDeltas?: (threadId: string, deltas: BackgroundTaskDelta[]) => void;
} = {}) {
  const threads = new Map<string, Map<string, BackgroundTask>>();
  const pending = new Map<string, RecordedToolEvent[]>();
  const threadTools = new Map<string, Map<string, RecordedToolEvent>>();
  const streamBuffers = new Map<string, string>();
  const watchers = new Map<string, Map<string, { offset: number; partial: string; decoder: StringDecoder }>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const interval = options.pollIntervalMs ?? 500;
  const taskKey = (task: BackgroundTask) => `${task.taskType === 'local_subagent' ? 'subagent' : 'task'}:${task.taskId}`;
  function delta(task: BackgroundTask, status?: BackgroundTaskDelta['status'], taskStatus?: string, summary?: string): BackgroundTaskDelta {
    const agent = task.taskType === 'local_subagent';
    return {
      kind: status ? 'item.close' : 'item.open',
      ...(status ? { status } : { attach: 'currentOrLast' as const }),
      key: { providerItemId: taskKey(task), ...(task.parentToolCallId ? { parentRef: task.parentToolCallId } : {}) },
      item: { type: 'backgroundTask', familyId: task.taskId, taskType: task.taskType, description: task.description,
        status: status ?? 'pending', taskStatus: taskStatus ?? 'running', skipTranscript: false, foreground: false,
        ...(task.outputFile ? { outputFile: task.outputFile } : {}), ...(summary ? { summary } : {}) },
      presentation: { label: { pending: `Running background ${agent ? 'agent' : 'command'}`, completed: `Background ${agent ? 'agent' : 'command'} finished` },
        icon: { glyph: agent ? 'Bot' : 'Terminal' }, title: task.description },
    };
  }
  function syncPolling() {
    for (const [thread, paths] of watchers) {
      for (const path of paths.keys()) {
        if (![...(threads.get(thread)?.values() ?? [])].some(t => t.transcriptPath === path)) paths.delete(path);
      }
      if (!paths.size) watchers.delete(thread);
    }
    if (!watchers.size && timer) { clearInterval(timer); timer = undefined; }
  }
  function settle(thread: string, id: string, status: NonNullable<BackgroundTaskDelta['status']>, taskStatus: string, summary?: string, type?: BackgroundTask['taskType']) {
    const tasks = threads.get(thread);
    const results: BackgroundTaskDelta[] = [];
    for (const [key, task] of tasks ?? []) {
      if ((task.taskId === id || task.taskId.endsWith(`/${id}`) || id.endsWith(`/${task.taskId}`)) && (!type || task.taskType === type)) { tasks!.delete(key); results.push(delta(task, status, taskStatus, summary)); }
    }
    if (!tasks?.size) threads.delete(thread);
    syncPolling();
    return results;
  }
  function inspectTextForCompletions(thread: string, text: string): BackgroundTaskDelta[] {
    const results: BackgroundTaskDelta[] = [];
    // Bound each result at the next announcement so failures cannot spill into another task.
    const announcements = [...text.matchAll(/Task id "([^"]+)" (finished with result:|was canceled|was killed|terminated|failed)/gi)];
    announcements.forEach((match, i) => {
      const result = text.slice(match.index! + match[0].length, announcements[i + 1]?.index ?? text.length);
      const failed = match[2].toLowerCase() === 'failed' || /Command exited with code ([1-9]\d*)|Encountered error/i.test(result);
      const killed = /was canceled|was killed|terminated/i.test(match[2]) || /Step was canceled/i.test(result);
      results.push(...settle(thread, match[1], failed ? 'failed' : killed ? 'interrupted' : 'completed', failed ? 'failed' : killed ? 'killed' : 'completed', result.trim(), 'local_bash'));
    });
    for (const match of text.matchAll(/Subagent ([^\s"]+) has gone idle/gi)) results.push(...settle(thread, match[1], 'completed', 'completed', undefined, 'local_subagent'));
    return results;
  }
  function poll() {
    for (const [thread, paths] of watchers) for (const [path, state] of paths) {
      let fd: number | undefined;
      let text = '';
      try {
        fd = openSync(path, 'r');
        const size = fstatSync(fd).size;
        if (size < state.offset) { state.offset = 0; state.partial = ''; state.decoder = new StringDecoder('utf8'); }
        if (size > state.offset) {
          const buffer = Buffer.alloc(size - state.offset);
          const count = readSync(fd, buffer, 0, buffer.length, state.offset);
          state.offset += count;
          const appended = state.partial + state.decoder.write(buffer.subarray(0, count));
          const end = appended.lastIndexOf('\n');
          state.partial = appended.slice(end + 1);
          text = appended.slice(0, end + 1);
        }
      } catch { /* The CLI may not have created the transcript yet. */ }
      finally { if (fd !== undefined) closeSync(fd); }
      if (text) {
        // Transcript records encode message text as JSON strings.
        text = text.split('\n').map(line => { try { return extractToolOutputText({ toolCallId: '', rawOutput: JSON.parse(line) }).replace(/\\"/g, '"'); } catch { return line; } }).join('\n');
        const deltas = inspectTextForCompletions(thread, text);
        if (deltas.length) options.onAsyncDeltas?.(thread, deltas);
      }
    }
  }
  function handleToolEventForThread(thread: string, event: RecordedToolEvent): BackgroundTaskDelta[] {
    if (disposed || event.status !== 'completed') return [];
    const input = event.rawInput ?? {};
    const text = extractToolOutputText(event);
    const inferred = inferAntigravityToolName(event as any);
    const name = (inferred && /^(run_command|schedule|invoke_subagent|manage_task|manage_subagents)$/.test(inferred) ? inferred : undefined)
      ?? [event.title, event.kind].find(v => /^(run_command|schedule|invoke_subagent|manage_task|manage_subagents)$/.test(v ?? '')) ?? '';
    const action = String(input.Action ?? '').toLowerCase();
    const results: BackgroundTaskDelta[] = [];
    if (name === 'manage_task') {
      const id = first(input.TaskId);
      if (action === 'kill' && id) return settle(thread, id, 'interrupted', 'killed', text, 'local_bash');
      if (action === 'status' && id && !/Step is still running|status\s*[:=]\s*RUNNING/i.test(text) && /Command exited with code \d+|SCHEDULE_FINISHED|Step was canceled|status\s*[:=]\s*(?:DONE|CANCELED|ERROR|COMPLETED|FAILED|KILLED|STOPPED)|not running|not found|unknown task|finished with result/i.test(text)) {
        const failed = /Command exited with code [1-9]\d*|ERROR|FAILED/i.test(text);
        const killed = /CANCELED|KILLED|interrupted/i.test(text);
        return settle(thread, id, failed ? 'failed' : killed ? 'interrupted' : 'completed', failed ? 'failed' : killed ? 'killed' : 'completed', text, 'local_bash');
      }
      if (action === 'list' && /No running tasks|\| Start Time \| Task ID \| Tool \| Description \|/i.test(text)) {
        for (const task of getActiveTasks(thread)) {
          const present = containsTaskToken(text, task.taskId) || containsTaskToken(text, task.taskId.split('/').pop()!);
          if (task.taskType === 'local_bash' && !present) results.push(...settle(thread, task.taskId, 'completed', 'completed', text, task.taskType));
        }
      }
    }
    if (name === 'manage_subagents') {
      const empty = /no active (?:direct )?subagents/i.test(text) || /^\s*\[\s*\]\s*$/.test(text)
        || (Array.isArray(event.rawOutput) && event.rawOutput.length === 0);
      for (const task of getActiveTasks(thread)) {
        if (task.taskType !== 'local_subagent') continue;
        const kill = action === 'kill_all' || (action === 'kill' && Array.isArray(input.ConversationIds) && input.ConversationIds.includes(task.taskId));
        const line = text.split('\n').find(line => containsTaskToken(line, task.taskId));
        if (kill || (action === 'list' && (empty || (line && /\bidle\b|\bdone\b|\bcompleted\b|\bkilled\b|\bstopped\b/i.test(line))))) results.push(...settle(thread, task.taskId, kill ? 'interrupted' : 'completed', kill ? 'killed' : 'completed', text, task.taskType));
      }
    }
    const agent = name === 'invoke_subagent';
    const raw = event.rawOutput as Record<string, unknown> | undefined;
    const spawnedId = /\bSubagent spawned\b/i.test(text) ? /\bconversationId:[ \t]*([^\s,]+)/i.exec(text)?.[1] : undefined;
    const id = agent ? first(raw?.conversationId, /"conversationId"\s*:\s*"([^"]+)"/.exec(text)?.[1], spawnedId)
      : /^(run_command|schedule)$/.test(name) ? first(/Tool is running as a background task with task id:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1], /Background command ID:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1]) : '';
    if (!id) return results;
    const title = /^(run_command|schedule|invoke_subagent)$/.test(event.title ?? '') ? '' : event.title;
    const outputFile = first(/Task logs are available at:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1]);
    const task: BackgroundTask = { taskId: id, taskType: agent ? 'local_subagent' : 'local_bash', parentToolCallId: event.toolCallId,
      description: agent ? first(input.Role, input.TypeName, title, id) : first(input.toolSummary, /Task Description:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1], input.CommandLine, input.command, input.Prompt, title, id),
      ...(outputFile ? { outputFile: normalizeFileUri(outputFile), transcriptPath: deriveTranscriptPathFromLogFile(outputFile) ?? undefined } : {}) };
    const tasks = threads.get(thread) ?? new Map<string, BackgroundTask>();
    if (tasks.has(taskKey(task))) return results;
    tasks.set(taskKey(task), task); threads.set(thread, tasks);
    if (task.transcriptPath && interval > 0) {
      const paths = watchers.get(thread) ?? new Map();
      if (!paths.has(task.transcriptPath)) {
        let offset = 0;
        try { offset = statSync(task.transcriptPath).size; } catch { /* Start at zero when the file appears. */ }
        paths.set(task.transcriptPath, { offset, partial: '', decoder: new StringDecoder('utf8') });
      }
      watchers.set(thread, paths);
      if (!timer) { timer = setInterval(poll, interval); timer.unref(); }
    }
    return [...results, delta(task)];
  }
  function getActiveTasks(thread: string): ReadonlyArray<BackgroundTask> { return [...(threads.get(thread)?.values() ?? [])].map(task => ({ ...task })); }
  function clearThread(thread: string, emitCloseDeltas = false): BackgroundTaskDelta[] {
    const results = emitCloseDeltas ? getActiveTasks(thread).map(task => delta(task, 'interrupted', 'stopped')) : [];
    threads.delete(thread); threadTools.delete(thread); streamBuffers.delete(thread); syncPolling(); return results;
  }
  return {
    recordToolEvent(event: RecordedToolEvent) {
      if (disposed) return;
      const queue = pending.get(event.toolCallId) ?? [];
      queue.push(event);
      pending.set(event.toolCallId, queue);
    },
    handleToolEventForThread, inspectTextForCompletions, getActiveTasks, clearThread,
    processStdoutLine(line: string): string[] {
      let message;
      try { message = JSON.parse(line); } catch { return [line]; }
      const params = message?.params;
      if (message?.method !== 'thread/delta' || typeof params?.threadId !== 'string' || !Array.isArray(params.deltas)) return [line];
      const extra: BackgroundTaskDelta[] = [];
      for (const entry of params.deltas) {
        const update = entry?.noTurnFallback?.raw?.params?.update;
        const id = entry?.key?.providerItemId ?? update?.toolCallId;
        if (typeof id === 'string') {
          const queue = pending.get(id);
          const queued = queue?.shift();
          if (!queue?.length) pending.delete(id);
          // The fallback update belongs to this exact thread; prefer it over the unscoped hook.
          const event = update && typeof update === 'object' ? { ...update, toolCallId: id } as RecordedToolEvent : queued;
          if (event) {
            const tools = threadTools.get(params.threadId) ?? new Map<string, RecordedToolEvent>();
            const merged = mergeToolEvent(tools.get(id), event);
            tools.set(id, merged); threadTools.set(params.threadId, tools);
            if (merged.status === 'completed' || merged.status === 'failed' || entry?.kind === 'item.close') {
              extra.push(...handleToolEventForThread(params.threadId, merged));
            }
          }
        }
        if (entry?.kind === 'item.textDelta' && typeof entry.text === 'string') {
          streamBuffers.set(params.threadId, (streamBuffers.get(params.threadId) ?? '') + entry.text);
        } else if (typeof entry?.text === 'string') {
          extra.push(...inspectTextForCompletions(params.threadId, entry.text));
        }
        if (entry?.kind === 'item.textClose' || entry?.kind === 'turn.boundary') {
          const buffered = streamBuffers.get(params.threadId);
          streamBuffers.delete(params.threadId);
          if (buffered) extra.push(...inspectTextForCompletions(params.threadId, buffered));
        }
        for (const text of [entry?.resultText, entry?.aggregatedOutput, entry?.message, entry?.delta?.text, entry?.item?.output, entry?.item?.text]) {
          if (typeof text === 'string') extra.push(...inspectTextForCompletions(params.threadId, text));
        }
      }
      if (!extra.length) return [line];
      params.deltas.push(...extra); return [JSON.stringify(message)];
    },
    handleInboundRequest(request: unknown): BackgroundTaskDelta[] {
      const message = request as { method?: string; params?: { threadId?: string } } | null;
      return message && /^(thread\/stop|thread\/discard)$/.test(message.method ?? '') && typeof message.params?.threadId === 'string' ? clearThread(message.params.threadId, true) : [];
    },
    dispose() { disposed = true; threads.clear(); pending.clear(); threadTools.clear(); streamBuffers.clear(); watchers.clear(); if (timer) clearInterval(timer); timer = undefined; },
  };
}
