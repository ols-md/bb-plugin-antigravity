import { createConnection, createServer } from 'node:net';
import { openSync, closeSync, fstatSync, readSync, statSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hostHomeDirectory } from './cli.ts';
import { inferAntigravityToolName } from './dialect.ts';

export interface RecordedToolEvent {
  toolCallId: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: unknown;
}
interface RetainedToolEvent extends RecordedToolEvent {
  outputTruncated?: boolean;
  taskStatusFromOutput?: ReturnType<typeof parseTaskStatus>;
  commandFailed?: boolean;
}
export interface BackgroundTask {
  taskId: string;
  taskType: 'local_bash' | 'local_subagent';
  description: string;
  parentToolCallId: string;
  outputFile?: string;
  transcriptPath?: string;
  /** Epoch ms when the task was registered; internal, used only for the persisted state file. */
  startedAt?: number;
  /** `run_command` with `IsDaemon: true` or a `schedule`: long-lived by design, so it never holds a turn open. */
  daemon?: boolean;
  /** Synthetic task for a `run_command` call the CLI left running when its prompt ended. */
  orphan?: boolean;
  /** Set once a hold has already waited on this task, so a task whose completion is never seen cannot stall later turns. */
  holdExempt?: boolean;
}
/** Durable record persisted for each registered background task so state survives host restarts. */
export interface PersistedBackgroundTask {
  threadId: string;
  taskId: string;
  taskType: BackgroundTask['taskType'];
  description: string;
  parentToolCallId: string;
  transcriptPath?: string;
  outputFile?: string;
  startedAt: number;
}
interface PersistedBackgroundTaskStateFile {
  version: 1;
  tasks: PersistedBackgroundTask[];
}
export interface BackgroundTaskDelta {
  kind: 'item.open' | 'item.close';
  attach?: 'currentOrLast';
  key: { providerItemId: string; parentRef?: string };
  status?: 'completed' | 'failed' | 'interrupted';
  item: Record<string, unknown>;
  presentation: Record<string, unknown>;
}
export interface SilentTurnInjectionDelta {
  kind: 'item.textDelta' | 'item.textClose';
  key: { channel: string };
  channel: 'agentMessage';
  text: string;
}
export interface TurnBoundaryDelta {
  kind: 'turn.boundary';
  status?: string;
  [field: string]: unknown;
}
export type TrackerDelta = BackgroundTaskDelta | SilentTurnInjectionDelta | TurnBoundaryDelta;
/** Default wait for the CLI's reactive follow-up turn after every blocking task settled. */
export const DEFAULT_HOLD_SETTLE_GRACE_MS = 20_000;
/** Default upper bound on how long one turn can be held open for background work. */
export const DEFAULT_MAX_TURN_HOLD_MS = 5 * 60 * 1000;
/** Default maximum bytes read from one transcript watcher in a single poll slice. */
export const DEFAULT_MAX_TRANSCRIPT_READ_BYTES = 64 * 1024;
/** Default maximum characters buffered for one transcript line before bounded streaming scan. */
export const DEFAULT_MAX_TRANSCRIPT_LINE_CHARS = 128 * 1024;
/** Default maximum characters retained for tool output and task completion summaries. */
export const DEFAULT_MAX_RETAINED_TOOL_OUTPUT_CHARS = 16 * 1024;
/** Default maximum in-flight tool records retained per thread. */
export const DEFAULT_MAX_RETAINED_TOOLS_PER_THREAD = 256;
/** Default maximum unconsumed tool events retained in the pending correlation queue. */
export const DEFAULT_MAX_PENDING_TOOL_EVENTS = 512;
/** Default maximum characters buffered per thread for streamed text completion scanning. */
export const DEFAULT_MAX_STREAM_BUFFER_CHARS = 64 * 1024;
const MAX_RETAINED_INPUT_STRING_CHARS = 2048;
const MAX_RETAINED_CONVERSATION_IDS = 256;
const MAX_COMPLETION_OVERLAP_CHARS = 4096;
const RETAINED_INPUT_STRING_KEYS = [
  'Action', 'TaskId', 'Role', 'TypeName', 'toolSummary', 'CommandLine', 'command', 'Prompt', 'CronExpression',
] as const;
const TERMINAL_TOOL_STATUS = /^(?:completed|failed|cancell?ed)$/;
const COMPLETION_HINT = /Task id|Subagent/i;
const TASK_ANNOUNCEMENT_RE = /Task id "([^"]+)" (finished with result:|was canceled|was killed|terminated|failed)/gi;
const SUBAGENT_IDLE_RE = /Subagent ([^\s"]+) has gone idle/gi;
const RESULT_FAILED_RE = /Command exited with code ([1-9]\d*)|Encountered error/i;
const RESULT_KILLED_RE = /Step was canceled/i;
const FLAG_TAIL_CHARS = 64;
const TRUNCATION_MARKER = '\n...[truncated]...\n';
// After this many consecutive silent turns (failed empty-output command, no agent text),
// the injected message escalates to "command execution appears broken in this session".
export const SILENT_TURN_ESCALATION_THRESHOLD = 2;
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

function sliceHeadSafe(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let end = maxLen;
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function sliceTailSafe(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let start = text.length - maxLen;
  if (start < text.length && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start += 1;
  return text.slice(start);
}

function boundText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= TRUNCATION_MARKER.length + 2) return sliceHeadSafe(text, maxChars);
  const budget = maxChars - TRUNCATION_MARKER.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${sliceHeadSafe(text, head)}${TRUNCATION_MARKER}${sliceTailSafe(text, tail)}`;
}

// "message" also appears in legacy transcript records.
const TRANSCRIPT_TEXT_KEYS = new Set(['text', 'content', 'output', 'message']);
const JSON_ARRAY_START = /^(?:["{\[\]]|(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?|-)(?=[ \t\r,\]]|$))/;

function extractTranscriptText(value: unknown): string {
  const strings: string[] = [];
  const pending = [value];
  while (pending.length) {
    const part = pending.pop();
    if (typeof part === 'string') {
      if (part) strings.push(part);
    } else if (Array.isArray(part)) {
      for (let i = part.length - 1; i >= 0; i -= 1) pending.push(part[i]);
    } else if (part && typeof part === 'object') {
      for (const [key, entry] of Object.entries(part).reverse()) {
        if (TRANSCRIPT_TEXT_KEYS.has(key)) pending.push(entry);
      }
    }
  }
  return strings.join('\n');
}

interface TranscriptJsonState {
  frames: { object: boolean; expectKey: boolean; selectValue: boolean }[];
  skipDepth: number;
  string?: 'key' | 'text-start' | 'text' | 'skip';
  key: string;
  escape: string;
  hasText: boolean;
  done: boolean;
  invalid: boolean;
}

function readTranscriptJson(state: TranscriptJsonState, raw: string, maxDepth: number): string {
  const input = state.escape + raw;
  state.escape = '';
  const stringToken = /[^"\\\x00-\x1f]+|\\(?:["\\/bfnrt]|u[\da-fA-F]{4})|"/y;
  const unselectedToken = /[^"[\]{},]+/y;
  let text = '';
  let pos = 0;
  while (pos < input.length && !state.invalid && !state.done) {
    const frame = state.frames.at(-1);
    const ch = input[pos];
    if (state.string) {
      stringToken.lastIndex = pos;
      const token = stringToken.exec(input)?.[0];
      if (!token) {
        if (ch === '\\' && input.length - pos < 6) state.escape = input.slice(pos);
        else state.invalid = true;
        break;
      }
      pos = stringToken.lastIndex;
      if (token === '"') {
        if (state.string === 'key' && frame) frame.selectValue = TRANSCRIPT_TEXT_KEYS.has(state.key);
        if (!frame && !state.skipDepth) state.done = true;
        state.string = undefined;
      } else if (state.string !== 'skip') {
        const decoded: string = ch === '\\' ? JSON.parse('"' + token + '"') : token;
        if (state.string === 'key') {
          // The longest selectable key is "content".
          if (state.key.length + decoded.length <= 7) state.key += decoded;
          else state.string = 'skip';
        } else {
          if (state.string === 'text-start' && state.hasText) text += '\n';
          text += decoded;
          state.string = 'text';
          state.hasText = true;
        }
      }
      continue;
    }

    const selected = !state.skipDepth && (!frame || frame.selectValue);
    pos += 1;
    if (ch === '"') {
      if (!state.skipDepth && frame?.expectKey) {
        frame.expectKey = false;
        frame.selectValue = false;
        state.key = '';
        state.string = 'key';
      } else {
        state.string = selected ? 'text-start' : 'skip';
      }
    } else if (ch === '{' || ch === '[') {
      // Track ignored subtrees by depth alone, including metadata nested inside message text.
      if (!selected || state.frames.length >= maxDepth) {
        state.skipDepth += 1;
      } else {
        const object = ch === '{';
        state.frames.push({ object, expectKey: object, selectValue: !object });
      }
    } else if (ch === '}' || ch === ']') {
      if (state.skipDepth) state.skipDepth -= 1;
      else if (frame?.object === (ch === '}')) state.frames.pop();
      else state.invalid = true;
      if (!state.frames.length && !state.skipDepth) state.done = true;
    } else if (ch === ',') {
      if (!state.skipDepth && frame?.object) {
        frame.expectKey = true;
        frame.selectValue = false;
      }
    } else {
      unselectedToken.lastIndex = pos - 1;
      unselectedToken.exec(input);
      pos = unselectedToken.lastIndex;
    }
  }
  return text;
}

function compactRawInput(rawInput: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined;
  const compact: Record<string, unknown> = {};
  for (const key of RETAINED_INPUT_STRING_KEYS) {
    const value = rawInput[key];
    if (typeof value === 'string') compact[key] = boundText(value, MAX_RETAINED_INPUT_STRING_CHARS);
  }
  if (typeof rawInput.IsDaemon === 'boolean' || typeof rawInput.IsDaemon === 'string') compact.IsDaemon = rawInput.IsDaemon;
  if (typeof rawInput.DurationSeconds === 'number' && Number.isFinite(rawInput.DurationSeconds)) compact.DurationSeconds = rawInput.DurationSeconds;
  if (Array.isArray(rawInput.ConversationIds)) {
    compact.ConversationIds = rawInput.ConversationIds
      .filter((item): item is string => typeof item === 'string')
      .slice(0, MAX_RETAINED_CONVERSATION_IDS)
      .map(item => boundText(item, MAX_RETAINED_INPUT_STRING_CHARS));
  }
  return Object.keys(compact).length ? compact : undefined;
}

function parseTaskStatus(text: string): 'running' | 'failed' | 'interrupted' | 'completed' | undefined {
  if (/Step is still running|status\s*[:=]\s*RUNNING/i.test(text)) return 'running';
  if (!/Command exited with code \d+|SCHEDULE_FINISHED|Step was canceled|status\s*[:=]\s*(?:DONE|CANCELED|ERROR|COMPLETED|FAILED|KILLED|STOPPED)|not running|not found|unknown task|finished with result/i.test(text)) return undefined;
  if (/Command exited with code [1-9]\d*|ERROR|FAILED/i.test(text)) return 'failed';
  if (/CANCELED|KILLED|interrupted/i.test(text)) return 'interrupted';
  return 'completed';
}

function compactToolEvent(event: RetainedToolEvent, maxOutputChars: number): RetainedToolEvent {
  const inferred = inferAntigravityToolName(event as any) ?? undefined;
  const hasOutput = event.content !== undefined || event.rawOutput !== undefined;
  const extracted = hasOutput ? extractToolOutputText(event) : undefined;
  const outputTruncated = Boolean((event as RetainedToolEvent).outputTruncated || (extracted !== undefined && extracted.length > maxOutputChars));
  const boundedContent = extracted !== undefined ? boundText(extracted, maxOutputChars) : undefined;
  let compactOutput: unknown = undefined;
  if (Array.isArray(event.rawOutput) && event.rawOutput.length === 0) {
    compactOutput = [];
  } else if (event.rawOutput && typeof event.rawOutput === 'object' && !Array.isArray(event.rawOutput)) {
    const conversationId = (event.rawOutput as Record<string, unknown>).conversationId;
    if (typeof conversationId === 'string') compactOutput = { conversationId: boundText(conversationId, MAX_RETAINED_INPUT_STRING_CHARS) };
  }
  const rawInput = compactRawInput(event.rawInput);
  return {
    toolCallId: event.toolCallId,
    ...(inferred ? { name: inferred } : typeof event.name === 'string' ? { name: boundText(event.name, MAX_RETAINED_INPUT_STRING_CHARS) } : {}),
    ...(typeof event.title === 'string' ? { title: boundText(event.title, MAX_RETAINED_INPUT_STRING_CHARS) } : {}),
    ...(typeof event.kind === 'string' ? { kind: event.kind } : {}),
    ...(typeof event.status === 'string' ? { status: event.status } : {}),
    ...(rawInput ? { rawInput } : {}),
    ...(boundedContent !== undefined ? { content: boundedContent } : {}),
    ...(compactOutput !== undefined ? { rawOutput: compactOutput } : {}),
    ...(outputTruncated ? {
      outputTruncated: true,
      taskStatusFromOutput: event.outputTruncated ? event.taskStatusFromOutput : parseTaskStatus(extracted ?? ''),
      commandFailed: event.outputTruncated ? event.commandFailed : /command exited with code [1-9]\d*/i.test(extracted ?? ''),
    } : {}),
  };
}

function mergeToolEvent(previous: RetainedToolEvent | undefined, event: RetainedToolEvent): RetainedToolEvent {
  const hasNewOutput = event.content !== undefined || event.rawOutput !== undefined;
  return {
    ...previous, ...event,
    name: event.name ?? previous?.name,
    title: event.title ?? previous?.title,
    kind: event.kind ?? previous?.kind,
    status: event.status ?? previous?.status,
    rawInput: previous?.rawInput && event.rawInput ? { ...previous.rawInput, ...event.rawInput } : event.rawInput ?? previous?.rawInput,
    rawOutput: event.rawOutput ?? previous?.rawOutput,
    content: event.content ?? previous?.content,
    taskStatusFromOutput: hasNewOutput ? event.taskStatusFromOutput : previous?.taskStatusFromOutput,
    commandFailed: hasNewOutput ? event.commandFailed : previous?.commandFailed,
    outputTruncated: hasNewOutput ? event.outputTruncated : previous?.outputTruncated,
  };
}

/**
 * Default maximum age of a persisted record before it is garbage-collected (a running task is
 * never expected to outlive this). Configurable per tracker via `taskStateMaxAgeMs`.
 */
const DEFAULT_TASK_STATE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function defaultBackgroundTaskStatePath(): string | undefined {
  const override = process.env.BB_ANTIGRAVITY_TASK_STATE_DIR?.trim();
  if (override) return join(override, 'background-tasks.json');
  const home = hostHomeDirectory();
  return home === undefined ? undefined : join(home, '.bb', 'plugin-data', 'bb-plugin-antigravity', 'background-tasks.json');
}

const LOCK_MARKER_PATTERN = /^(\d+)-(?:(ab)-)?([0-9a-f-]+)\.lock$/i;

// An ordinary UUID starts with eight hex digits, so "ab-" distinguishes new markers
// while remaining inside the character set recognized by older writers.
function lockEndpoint(lockDir: string, token: string) {
  if (process.platform === 'win32') return { path: `\\\\.\\pipe\\bb-antigravity-${token}` };
  const name = `${token}.sock`;
  const path = join(lockDir, name);
  if (Buffer.byteLength(path) < 100) return { path };
  // Unix socket addresses are length-limited. Each caller can reach the shared
  // directory through its own short alias, even from a private /tmp mount.
  const alias = join('/tmp', randomUUID());
  symlinkSync(resolve(lockDir), alias);
  return { path: join(alias, name), alias };
}

const pendingProbes = new Set<string>();

function probeLockOwner(lockDir: string, marker: string, token: string, fsOps: TaskStateFs): void {
  if (pendingProbes.has(marker)) return;
  const endpoint = lockEndpoint(lockDir, token);
  const socket = createConnection(endpoint.path);
  pendingProbes.add(marker);
  socket.once('connect', () => socket.destroy());
  socket.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') return;
    unlinkUniqueMarker(marker, fsOps);
    if (process.platform !== 'win32') unlinkUniqueMarker(join(lockDir, `${token}.sock`), fsOps);
  });
  socket.once('close', () => {
    pendingProbes.delete(marker);
    if (endpoint.alias) unlinkUniqueMarker(endpoint.alias);
  });
  socket.unref();
}

const LOCK_RETRY_BASE_MS = 10;
const LOCK_RETRY_MAX_MS = 500;
const TRANSIENT_IO_MAX_RETRIES = 20;

export interface TaskStateFs {
  openSync: typeof openSync;
  closeSync: typeof closeSync;
  statSync: typeof statSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  mkdirSync: typeof mkdirSync;
  unlinkSync: typeof unlinkSync;
}

const DEFAULT_TASK_STATE_FS: TaskStateFs = {
  openSync, closeSync, statSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync, unlinkSync,
};

function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function retryDelayMs(attempt: number): number {
  const base = Math.min(LOCK_RETRY_MAX_MS, LOCK_RETRY_BASE_MS * (2 ** Math.min(attempt, 6)));
  return base + Math.floor(Math.random() * base);
}

function isDirectoryPath(path: string, fsOps: TaskStateFs = DEFAULT_TASK_STATE_FS): boolean {
  try {
    return fsOps.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPidDefinitivelyDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function unlinkUniqueMarker(markerPath: string, fsOps: TaskStateFs = DEFAULT_TASK_STATE_FS, attempt = 0): void {
  try {
    fsOps.unlinkSync(markerPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (isTransientFsError(error) && attempt < TRANSIENT_IO_MAX_RETRIES) {
      const timer = setTimeout(() => unlinkUniqueMarker(markerPath, fsOps, attempt + 1), retryDelayMs(attempt));
      timer.unref?.();
    }
  }
}

/**
 * Non-blocking cross-process lock around `background-tasks.json` using unique per-attempt
 * markers in `<path>.locks/`. Each attempt binds a unique local socket, publishes its marker with `wx`, and enumerates
 * all markers before the critical section. It prunes dead PIDs, probes other socket owners, and
 * yields (removing only its own unique marker) if any other live contender exists. Live writers
 * are never evicted by age, and unique marker names prevent shared-filename unlink races.
 */
export function withTaskStateLock<T>(
  path: string,
  fn: () => T,
  fsOverrides?: Partial<TaskStateFs>,
): { status: 'acquired'; value: T } | { status: 'contended' | 'transient' | 'error' } {
  if (!path) return { status: 'error' };
  const fsOps: TaskStateFs = fsOverrides ? { ...DEFAULT_TASK_STATE_FS, ...fsOverrides } : DEFAULT_TASK_STATE_FS;
  const lockDir = `${path}.locks`;
  const token = randomUUID();
  const markerName = `${process.pid}-ab-${token}.lock`;
  const owner = createServer(socket => socket.destroy());
  owner.on('error', () => {});
  const markerPath = join(lockDir, markerName);
  let markerCreated = false;
  let boundThroughAlias = false;
  try {
    try {
      fsOps.mkdirSync(lockDir, { recursive: true });
      const endpoint = lockEndpoint(lockDir, token);
      try {
        owner.listen(endpoint.path).unref();
        if (!owner.listening) return { status: 'transient' };
        boundThroughAlias = !!endpoint.alias;
      } finally {
        if (endpoint.alias) unlinkUniqueMarker(endpoint.alias);
      }
      const fd = fsOps.openSync(markerPath, 'wx');
      markerCreated = true;
      fsOps.closeSync(fd);
      for (const entry of fsOps.readdirSync(lockDir)) {
        if (entry === markerName) continue;
        const match = LOCK_MARKER_PATTERN.exec(entry);
        if (!match) continue;
        if (match[2]) {
          probeLockOwner(lockDir, join(lockDir, entry), match[3], fsOps);
        } else if (isPidDefinitivelyDead(Number(match[1]))) {
          unlinkUniqueMarker(join(lockDir, entry), fsOps);
          continue;
        }
        return { status: 'contended' };
      }
    } catch (error) {
      return isTransientFsError(error) ? { status: 'transient' } : { status: 'error' };
    }
    return { status: 'acquired', value: fn() };
  } finally {
    owner.close();
    if (boundThroughAlias) unlinkUniqueMarker(join(lockDir, `${token}.sock`));
    if (markerCreated) unlinkUniqueMarker(markerPath, fsOps);
  }
}

interface LoadedTaskState {
  tasks: PersistedBackgroundTask[];
  needsWrite: boolean;
  ioError: 'none' | 'transient' | 'fatal';
}

/** Loads and validates the state file. Missing or corrupt files degrade to an empty list. */
function loadTaskState(path: string, maxAgeMs: number, fsOps: TaskStateFs = DEFAULT_TASK_STATE_FS): LoadedTaskState {
  if (!path) return { tasks: [], needsWrite: false, ioError: 'none' };
  let raw: string;
  try {
    raw = fsOps.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], needsWrite: false, ioError: 'none' };
    return { tasks: [], needsWrite: false, ioError: isTransientFsError(error) && !isDirectoryPath(path, fsOps) ? 'transient' : 'fatal' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { tasks: [], needsWrite: true, ioError: 'none' }; }
  if (!parsed || typeof parsed !== 'object') return { tasks: [], needsWrite: true, ioError: 'none' };
  const file = parsed as { version?: unknown; tasks?: unknown };
  if (file.version !== 1 || !Array.isArray(file.tasks)) return { tasks: [], needsWrite: true, ioError: 'none' };
  const cutoff = Date.now() - Math.max(0, maxAgeMs); // Garbage-collect stale records.
  const records: PersistedBackgroundTask[] = [];
  let pruned = false;
  for (const entry of file.tasks) {
    if (!entry || typeof entry !== 'object') { pruned = true; continue; }
    const task = entry as Partial<PersistedBackgroundTask>;
    if (typeof task.threadId !== 'string' || typeof task.taskId !== 'string' || typeof task.description !== 'string' ||
        typeof task.parentToolCallId !== 'string' || typeof task.startedAt !== 'number' ||
        !Number.isFinite(task.startedAt) || task.startedAt < cutoff ||
        (task.taskType !== 'local_bash' && task.taskType !== 'local_subagent')) {
      pruned = true;
      continue;
    }
    records.push({
      threadId: task.threadId, taskId: task.taskId, taskType: task.taskType, description: task.description,
      parentToolCallId: task.parentToolCallId, startedAt: task.startedAt,
      ...(typeof task.transcriptPath === 'string' ? { transcriptPath: task.transcriptPath } : {}),
      ...(typeof task.outputFile === 'string' ? { outputFile: task.outputFile } : {}),
    });
  }
  return { tasks: records, needsWrite: pruned, ioError: 'none' };
}

/** Atomic-ish write: temp file + rename, so a crash mid-write can never corrupt the state file. */
function writeTaskState(path: string, tasks: PersistedBackgroundTask[], fsOps: TaskStateFs = DEFAULT_TASK_STATE_FS): 'saved' | 'transient' | 'failed' {
  let temp: string | undefined;
  try {
    fsOps.mkdirSync(dirname(path), { recursive: true });
    temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    fsOps.writeFileSync(temp, `${JSON.stringify({ version: 1, tasks } satisfies PersistedBackgroundTaskStateFile)}\n`);
    fsOps.renameSync(temp, path);
    temp = undefined;
    return 'saved';
  } catch (error) {
    // Best effort: persistence trouble (missing dir permissions, full disk, ...) must never
    // crash the plugin host. Keep pending changes for the next save.
    if (temp) { try { fsOps.unlinkSync(temp); } catch {} }
    return isTransientFsError(error) && !isDirectoryPath(path, fsOps) ? 'transient' : 'failed';
  }
}

export function createBackgroundTaskTracker(options: {
  pollIntervalMs?: number;
  onAsyncDeltas?: (threadId: string, deltas: TrackerDelta[]) => void;
  /** Path of the persisted state file; omit to keep tracking in memory only (used by tests and the dev harness). */
  persistPath?: string;
  taskStateMaxAgeMs?: number;
  /** Optional filesystem overrides for persisted task state and lock I/O (used by deterministic fault-injection tests). */
  taskStateFs?: Partial<TaskStateFs>;
  /** Hold a completed turn open while non-daemon background work it started is still running (default true). */
  holdTurns?: boolean;
  /** How long to wait for the CLI's reactive follow-up turn once every blocking task settled. */
  holdSettleGraceMs?: number;
  /** Safety cap on a single hold; the held boundary is released when it expires. */
  maxTurnHoldMs?: number;
  /** Maximum bytes read per transcript watcher in a single poll slice (default 64 KiB). */
  maxTranscriptReadBytes?: number;
  /** Maximum characters buffered for one transcript line before bounded streaming scan (default 128 KiB). */
  maxTranscriptLineChars?: number;
  /** Maximum characters retained for tool output and task completion summaries (default 16 KiB). */
  maxRetainedToolOutputChars?: number;
  /** Maximum in-flight tool records retained per thread (default 256). */
  maxRetainedToolsPerThread?: number;
  /** Maximum unconsumed tool events retained in the pending correlation queue (default 512). */
  maxPendingToolEvents?: number;
  /** Maximum characters buffered per thread for streamed text completion scanning (default 64 KiB). */
  maxStreamBufferChars?: number;
} = {}) {
  interface PendingAnnouncement {
    taskId: string;
    failed: boolean;
    killed: boolean;
    summaryHead: string;
    summaryTail: string;
    truncated: boolean;
    flagTail: string;
  }
  interface StreamingScanState {
    buffer: string;
    pending?: PendingAnnouncement;
  }
  interface TranscriptWatcherState {
    plainScan?: StreamingScanState;
    offset: number;
    partial: string;
    oversized?: { prefix: string; kind?: 'json' | 'plain'; json?: TranscriptJsonState; scan?: StreamingScanState };
    decoder: StringDecoder;
  }
  const threads = new Map<string, Map<string, BackgroundTask>>();
  const pending = new Map<string, RetainedToolEvent[]>();
  let pendingCount = 0;
  const threadTools = new Map<string, Map<string, RetainedToolEvent>>();
  const streamBuffers = new Map<string, StreamingScanState>();
  const watchers = new Map<string, Map<string, TranscriptWatcherState>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let catchUpTimer: ReturnType<typeof setImmediate> | undefined;
  let readBuffer: Buffer | undefined;
  let disposed = false;
  const interval = options.pollIntervalMs ?? 500;
  const persistPath = options.persistPath || undefined;
  const maxAge = options.taskStateMaxAgeMs ?? DEFAULT_TASK_STATE_MAX_AGE_MS;
  const fsOps: TaskStateFs = options.taskStateFs ? { ...DEFAULT_TASK_STATE_FS, ...options.taskStateFs } : DEFAULT_TASK_STATE_FS;
  const trackerStartedAt = Date.now();
  const maxReadBytes = Math.max(16, Math.floor(options.maxTranscriptReadBytes ?? DEFAULT_MAX_TRANSCRIPT_READ_BYTES));
  const maxLineChars = Math.max(256, Math.floor(options.maxTranscriptLineChars ?? DEFAULT_MAX_TRANSCRIPT_LINE_CHARS));
  const lineOverlap = Math.min(MAX_COMPLETION_OVERLAP_CHARS, Math.floor(maxLineChars / 2));
  const maxToolOutputChars = Math.max(128, Math.floor(options.maxRetainedToolOutputChars ?? DEFAULT_MAX_RETAINED_TOOL_OUTPUT_CHARS));
  const maxToolsPerThread = Math.max(1, Math.floor(options.maxRetainedToolsPerThread ?? DEFAULT_MAX_RETAINED_TOOLS_PER_THREAD));
  const maxPendingEvents = Math.max(1, Math.floor(options.maxPendingToolEvents ?? DEFAULT_MAX_PENDING_TOOL_EVENTS));
  const maxStreamChars = Math.max(256, Math.floor(options.maxStreamBufferChars ?? DEFAULT_MAX_STREAM_BUFFER_CHARS));
  const streamOverlap = Math.min(MAX_COMPLETION_OVERLAP_CHARS, Math.floor(maxStreamChars / 2));
  const taskKey = (task: Pick<BackgroundTask, 'taskType' | 'taskId'>) => `${task.taskType === 'local_subagent' ? 'subagent' : 'task'}:${task.taskId}`;
  // Silent-turn detection state (issue: turn ends with no agent message after a failed
  // command with empty output, so BB records "No final output was recorded").
  const silentTurns = new Map<string, { agentText: boolean; emptyFailedCommand: boolean; streak: number }>();
  function silentState(thread: string): { agentText: boolean; emptyFailedCommand: boolean; streak: number } {
    let state = silentTurns.get(thread);
    if (!state) {
      state = { agentText: false, emptyFailedCommand: false, streak: 0 };
      silentTurns.set(thread, state);
    }
    return state;
  }
  function silentTurnMessage(streak: number): string {
    if (streak >= SILENT_TURN_ESCALATION_THRESHOLD) {
      return `Command execution appears broken in this session: ${streak} consecutive turns ended without an agent response after commands failed with empty output. Restart the thread runtime (reload the thread) or restart the host.`;
    }
    return 'The Antigravity agent ended this turn without a response after a command failed with empty output. Command execution may be broken in the CLI runtime — try reloading the thread or restarting the host.';
  }
  // Injected warnings reuse the exact wire shape the SDK's ACP bridge uses for genuine agent
  // messages: an `item.textDelta` + `item.textClose` pair on the assistant stream key
  // (`key.channel: "assistant"`, `channel: "agentMessage"`). The host delta assembler
  // auto-opens an `agentMessage` item on the first textDelta and settles it on the textClose,
  // recording the text as the turn's agent output. The pair must be inserted *before* the
  // `turn.boundary` entry in the delta list: after the boundary the host closes the turn,
  // and any text delta appended past it would be dropped instead of recorded.
  function silentTurnInjection(text: string): SilentTurnInjectionDelta[] {
    return [
      { kind: 'item.textDelta', key: { channel: 'assistant' }, channel: 'agentMessage', text },
      { kind: 'item.textClose', key: { channel: 'assistant' }, channel: 'agentMessage', text },
    ];
  }
  function handleTurnBoundary(thread: string, status: unknown): string | null {
    const state = silentState(thread);
    const silent = !state.agentText && state.emptyFailedCommand;
    let message: string | null = null;
    if (status === 'completed' && silent) {
      state.streak += 1;
      message = silentTurnMessage(state.streak);
    } else if (!silent) {
      // Any turn that emitted agent text or had no such failure resets the streak.
      state.streak = 0;
    }
    // Interrupted/failed boundaries with the silent pattern are ambiguous (e.g. the user
    // stopped the turn): leave the streak untouched so a later confirmed silent turn escalates.
    state.agentText = false;
    state.emptyFailedCommand = false;
    return message;
  }
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
  const toRecord = (thread: string, task: BackgroundTask): PersistedBackgroundTask => ({
    threadId: thread, taskId: task.taskId, taskType: task.taskType, description: task.description,
    parentToolCallId: task.parentToolCallId, startedAt: task.startedAt ?? Date.now(),
    ...(task.transcriptPath ? { transcriptPath: task.transcriptPath } : {}),
    ...(task.outputFile ? { outputFile: task.outputFile } : {}),
  });
  const recordKey = (record: PersistedBackgroundTask) => JSON.stringify([record.threadId, taskKey(record)]);
  const toInterruptedDelta = (record: PersistedBackgroundTask) => delta({
    taskId: record.taskId, taskType: record.taskType, description: record.description, parentToolCallId: record.parentToolCallId,
    ...(record.transcriptPath ? { transcriptPath: record.transcriptPath } : {}), ...(record.outputFile ? { outputFile: record.outputFile } : {}),
  }, 'interrupted', 'stopped');
  const pendingWrites = new Map<string, { record: PersistedBackgroundTask; remove: boolean; delayed: boolean; predecessorToolCallId?: string }>();
  const pendingReconciliations = new Set<string>();
  const localTouchedBeforeStartupLoad = new Set<string>();
  const clearedBeforeStartupLoad = new Set<string>();
  let persistRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let persistRetryAttempt = 0;
  let transientRetryAttempt = 0;
  let startupLoadPending = false;
  let startupGcPending = false;
  function hasPendingPersistenceWork(): boolean {
    return pendingWrites.size > 0 || startupLoadPending || startupGcPending || pendingReconciliations.size > 0;
  }
  function clearPersistRetry() {
    if (persistRetryTimer) { clearTimeout(persistRetryTimer); persistRetryTimer = undefined; }
    persistRetryAttempt = 0;
    transientRetryAttempt = 0;
  }
  function schedulePersistRetry() {
    if (disposed || !persistPath || persistRetryTimer) return;
    const delay = retryDelayMs(persistRetryAttempt);
    persistRetryAttempt += 1;
    persistRetryTimer = setTimeout(() => {
      persistRetryTimer = undefined;
      flushPendingWrites();
    }, delay);
    persistRetryTimer.unref?.();
  }
  function markPendingAddsDelayed() {
    for (const change of pendingWrites.values()) {
      if (!change.remove) change.delayed = true;
    }
  }
  function clearInitialRecordsForThread(thread: string) {
    for (const [key, record] of initialRecords) {
      if (record.threadId === thread) initialRecords.delete(key);
    }
  }
  function matchingInitialRecords(thread: string, records: PersistedBackgroundTask[]): PersistedBackgroundTask[] {
    const active = threads.get(thread);
    return records.filter(record => {
      const initial = initialRecords.get(recordKey(record));
      return record.threadId === thread && !active?.has(taskKey(record)) &&
        initial?.startedAt === record.startedAt && initial.parentToolCallId === record.parentToolCallId;
    });
  }
  function queuePendingWrites(thread: string, tasks: BackgroundTask[], remove: boolean) {
    for (const task of tasks) {
      const record = toRecord(thread, task);
      const key = recordKey(record);
      pendingWrites.set(JSON.stringify([key, record.startedAt, record.parentToolCallId]), { record, remove, delayed: false });
      initialRecords.delete(key);
      if (startupLoadPending) localTouchedBeforeStartupLoad.add(key);
    }
  }
  function populateInitialRecords(tasks: PersistedBackgroundTask[], fromDelayedStartup: boolean) {
    for (const record of tasks) {
      if (fromDelayedStartup && record.startedAt > trackerStartedAt) continue;
      const key = recordKey(record);
      if (fromDelayedStartup && (localTouchedBeforeStartupLoad.has(key) || threads.get(record.threadId)?.has(taskKey(record)))) continue;
      if (fromDelayedStartup && clearedBeforeStartupLoad.has(record.threadId)) {
        pendingWrites.set(JSON.stringify([key, record.startedAt, record.parentToolCallId]), { record, remove: true, delayed: false });
        continue;
      }
      initialRecords.set(key, record);
    }
    startupLoadPending = false;
    localTouchedBeforeStartupLoad.clear();
    clearedBeforeStartupLoad.clear();
  }
  function applyPendingWrites(loadedTasks: PersistedBackgroundTask[]): PersistedBackgroundTask[] {
    const persisted = new Map(loadedTasks.map(record => [recordKey(record), record]));
    const records = new Map(persisted);
    for (const change of pendingWrites.values()) {
      const key = recordKey(change.record);
      const existing = records.get(key);
      if (change.remove) {
        if (existing?.startedAt === change.record.startedAt && existing.parentToolCallId === change.record.parentToolCallId) records.delete(key);
        continue;
      }
      const onDisk = persisted.get(key);
      const sameTimestamp = onDisk?.startedAt === change.record.startedAt;
      const samePredecessor = sameTimestamp && onDisk.parentToolCallId === change.predecessorToolCallId;
      if (onDisk && change.predecessorToolCallId !== undefined && !samePredecessor) continue;
      if (!existing || existing.startedAt < change.record.startedAt ||
          (existing.startedAt === change.record.startedAt && (!change.delayed || samePredecessor))) {
        if (!change.delayed && sameTimestamp && onDisk.parentToolCallId !== change.record.parentToolCallId) {
          change.predecessorToolCallId = onDisk.parentToolCallId;
        }
        records.set(key, change.record);
      }
    }
    return [...records.values()];
  }
  function flushPendingWrites() {
    if (disposed || !persistPath || !hasPendingPersistenceWork()) { clearPersistRetry(); return; }
    const asyncReconciled: Array<{ thread: string; deltas: BackgroundTaskDelta[] }> = [];
    const locked = withTaskStateLock(persistPath, () => {
      const loaded = loadTaskState(persistPath, maxAge, fsOps);
      if (loaded.ioError !== 'none') return loaded.ioError === 'transient' ? 'transient' as const : 'failed' as const;
      if (startupLoadPending) {
        populateInitialRecords(loaded.tasks, true);
        if (loaded.needsWrite) startupGcPending = true;
      }
      if (pendingReconciliations.size) {
        for (const thread of [...pendingReconciliations]) {
          const matched = matchingInitialRecords(thread, loaded.tasks);
          clearInitialRecordsForThread(thread);
          pendingReconciliations.delete(thread);
          if (matched.length) {
            queuePendingWrites(thread, matched, true);
            asyncReconciled.push({ thread, deltas: matched.map(toInterruptedDelta) });
          }
        }
      }
      if (pendingWrites.size) {
        const result = writeTaskState(persistPath, applyPendingWrites(loaded.tasks), fsOps);
        if (result !== 'saved') return result;
        pendingWrites.clear();
        startupGcPending = false;
        return 'saved' as const;
      }
      if (startupGcPending) {
        if (loaded.needsWrite) {
          const result = writeTaskState(persistPath, loaded.tasks, fsOps);
          if (result !== 'saved') return result;
        }
        startupGcPending = false;
      }
      return 'saved' as const;
    }, fsOps);
    if (locked.status === 'contended') {
      markPendingAddsDelayed();
      transientRetryAttempt = 0;
      schedulePersistRetry();
      return;
    }
    if (locked.status === 'transient') {
      markPendingAddsDelayed();
      if (transientRetryAttempt < TRANSIENT_IO_MAX_RETRIES) {
        transientRetryAttempt += 1;
        schedulePersistRetry();
      }
      return;
    }
    if (locked.status === 'acquired') {
      if (locked.value === 'saved') {
        clearPersistRetry();
      } else {
        markPendingAddsDelayed();
        if (locked.value === 'transient' && transientRetryAttempt < TRANSIENT_IO_MAX_RETRIES) {
          transientRetryAttempt += 1;
          schedulePersistRetry();
        }
      }
    } else {
      markPendingAddsDelayed();
    }
    for (const entry of asyncReconciled) {
      if (disposed) break;
      options.onAsyncDeltas?.(entry.thread, entry.deltas);
    }
  }
  function persistTasks(thread: string, tasks: BackgroundTask[], remove: boolean) {
    if (disposed || !persistPath) return;
    queuePendingWrites(thread, tasks, remove);
    if (!pendingWrites.size) return;
    persistRetryAttempt = 0;
    transientRetryAttempt = 0;
    flushPendingWrites();
  }
  /**
   * Restart reconciliation: `clearThread`-shaped `interrupted` closes for persisted tasks of a
   * resumed thread that were never settled in this process, then drops those records so BB and
   * the resumed agent learn the tasks died with the previous host.
   */
  function reconcilePersisted(thread: string): BackgroundTaskDelta[] {
    if (disposed || !persistPath) return [];
    const hasInitialForThread = [...initialRecords.values()].some(record => record.threadId === thread);
    if (!startupLoadPending && !hasInitialForThread) return [];
    let pending: PersistedBackgroundTask[] = [];
    const locked = withTaskStateLock(persistPath, () => {
      const loaded = loadTaskState(persistPath, maxAge, fsOps);
      if (loaded.ioError !== 'none') return { outcome: loaded.ioError, readSucceeded: false };
      if (startupLoadPending) {
        populateInitialRecords(loaded.tasks, true);
        if (loaded.needsWrite) startupGcPending = true;
      }
      pending = matchingInitialRecords(thread, loaded.tasks);
      clearInitialRecordsForThread(thread);
      pendingReconciliations.delete(thread);
      if (pending.length) queuePendingWrites(thread, pending, true);
      if (pendingWrites.size) {
        const result = writeTaskState(persistPath, applyPendingWrites(loaded.tasks), fsOps);
        if (result === 'saved') {
          pendingWrites.clear();
          startupGcPending = false;
          return { outcome: 'saved' as const, readSucceeded: true };
        }
        return { outcome: result === 'transient' ? 'transient' as const : 'fatal' as const, readSucceeded: true };
      }
      if (startupGcPending) {
        if (loaded.needsWrite) {
          const result = writeTaskState(persistPath, loaded.tasks, fsOps);
          if (result !== 'saved') return { outcome: result === 'transient' ? 'transient' as const : 'fatal' as const, readSucceeded: true };
        }
        startupGcPending = false;
      }
      return { outcome: 'saved' as const, readSucceeded: true };
    }, fsOps);
    if (locked.status === 'acquired') {
      if (locked.value.outcome === 'saved') {
        if (hasPendingPersistenceWork()) {
          persistRetryAttempt = 0;
          transientRetryAttempt = 0;
          schedulePersistRetry();
        } else {
          clearPersistRetry();
        }
      } else if (locked.value.outcome === 'transient') {
        markPendingAddsDelayed();
        if (!locked.value.readSucceeded) pendingReconciliations.add(thread);
        persistRetryAttempt = 0;
        transientRetryAttempt = 1;
        schedulePersistRetry();
      } else {
        markPendingAddsDelayed();
      }
    } else {
      const loaded = loadTaskState(persistPath, maxAge, fsOps);
      if (loaded.ioError === 'none') {
        if (startupLoadPending) {
          populateInitialRecords(loaded.tasks, true);
          if (loaded.needsWrite) startupGcPending = true;
        }
        pending = matchingInitialRecords(thread, loaded.tasks);
        clearInitialRecordsForThread(thread);
        pendingReconciliations.delete(thread);
        if (pending.length) queuePendingWrites(thread, pending, true);
        if (locked.status === 'contended' && hasPendingPersistenceWork()) {
          persistRetryAttempt = 0;
          transientRetryAttempt = 0;
          schedulePersistRetry();
        } else if (locked.status === 'transient' && hasPendingPersistenceWork()) {
          persistRetryAttempt = 0;
          transientRetryAttempt = 1;
          schedulePersistRetry();
        }
      } else if (loaded.ioError === 'transient' && locked.status !== 'error') {
        pendingReconciliations.add(thread);
        persistRetryAttempt = 0;
        transientRetryAttempt = 1;
        schedulePersistRetry();
      }
    }
    if (!pending.length) return [];
    return pending.map(toInterruptedDelta);
  }
  function syncPolling() {
    for (const [thread, paths] of watchers) {
      for (const path of paths.keys()) {
        if (![...(threads.get(thread)?.values() ?? [])].some(t => t.transcriptPath === path)) paths.delete(path);
      }
      if (!paths.size) watchers.delete(thread);
    }
    if (!watchers.size) {
      if (timer) { clearInterval(timer); timer = undefined; }
      if (catchUpTimer) { clearImmediate(catchUpTimer); catchUpTimer = undefined; }
      readBuffer = undefined;
    }
  }
  function settle(thread: string, id: string, status: NonNullable<BackgroundTaskDelta['status']>, taskStatus: string, summary?: string, type?: BackgroundTask['taskType']) {
    const tasks = threads.get(thread);
    const removed: BackgroundTask[] = [];
    const results: BackgroundTaskDelta[] = [];
    const boundedSummary = summary ? boundText(summary, maxToolOutputChars) : summary;
    for (const [key, task] of tasks ?? []) {
      if ((task.taskId === id || task.taskId.endsWith(`/${id}`) || id.endsWith(`/${task.taskId}`)) && (!type || task.taskType === type)) { tasks!.delete(key); removed.push(task); results.push(delta(task, status, taskStatus, boundedSummary)); }
    }
    if (!tasks?.size) { threads.delete(thread); streamBuffers.delete(thread); }
    syncPolling();
    if (removed.length) {
      persistTasks(thread, removed, true);
      armSettleGrace(thread);
    }
    return results;
  }
  function inspectTextForCompletions(thread: string, text: string, maxMatchIndex = text.length): BackgroundTaskDelta[] {
    if (disposed || !threads.get(thread)?.size) return [];
    const results: BackgroundTaskDelta[] = [];
    // Bound each result at the next announcement so failures cannot spill into another task.
    const announcements = [...text.matchAll(TASK_ANNOUNCEMENT_RE)];
    announcements.forEach((match, i) => {
      if (match.index! >= maxMatchIndex) return;
      const result = text.slice(match.index! + match[0].length, announcements[i + 1]?.index ?? text.length);
      const failed = match[2].toLowerCase() === 'failed' || RESULT_FAILED_RE.test(result);
      const killed = /was canceled|was killed|terminated/i.test(match[2]) || RESULT_KILLED_RE.test(result);
      results.push(...settle(thread, match[1], failed ? 'failed' : killed ? 'interrupted' : 'completed', failed ? 'failed' : killed ? 'killed' : 'completed', result.trim(), 'local_bash'));
    });
    for (const match of text.matchAll(SUBAGENT_IDLE_RE)) {
      if (match.index! >= maxMatchIndex) break;
      results.push(...settle(thread, match[1], 'completed', 'completed', undefined, 'local_subagent'));
    }
    return results;
  }
  function appendPendingResult(pendingAnnouncement: PendingAnnouncement, fragment: string) {
    if (!fragment) return;
    const flagWindow = pendingAnnouncement.flagTail ? pendingAnnouncement.flagTail + fragment : fragment;
    if (!pendingAnnouncement.failed && RESULT_FAILED_RE.test(flagWindow)) pendingAnnouncement.failed = true;
    if (!pendingAnnouncement.killed && RESULT_KILLED_RE.test(flagWindow)) pendingAnnouncement.killed = true;
    pendingAnnouncement.flagTail = flagWindow.slice(-FLAG_TAIL_CHARS);

    const budget = Math.max(0, maxToolOutputChars - TRUNCATION_MARKER.length);
    const headLen = Math.ceil(budget / 2);
    const tailLen = budget - headLen;
    const rollingTailCap = tailLen + 256;

    if (!pendingAnnouncement.truncated) {
      const piece = pendingAnnouncement.summaryHead ? fragment : fragment.trimStart();
      if (!piece) return;
      if (pendingAnnouncement.summaryHead.length + piece.length <= maxToolOutputChars) {
        pendingAnnouncement.summaryHead += piece;
      } else {
        const full = pendingAnnouncement.summaryHead + piece;
        pendingAnnouncement.truncated = true;
        pendingAnnouncement.summaryHead = sliceHeadSafe(full, headLen);
        pendingAnnouncement.summaryTail = sliceTailSafe(full, rollingTailCap);
      }
    } else {
      const combinedTail = pendingAnnouncement.summaryTail ? pendingAnnouncement.summaryTail + fragment : fragment;
      pendingAnnouncement.summaryTail = sliceTailSafe(combinedTail, rollingTailCap);
    }
  }
  function finalizePendingAnnouncement(thread: string, pendingAnnouncement: PendingAnnouncement): BackgroundTaskDelta[] {
    let summary: string;
    if (!pendingAnnouncement.truncated) {
      summary = pendingAnnouncement.summaryHead.trim();
    } else if (maxToolOutputChars <= TRUNCATION_MARKER.length + 2) {
      summary = pendingAnnouncement.summaryHead.trim().slice(0, maxToolOutputChars);
    } else {
      const budget = maxToolOutputChars - TRUNCATION_MARKER.length;
      const headLen = Math.ceil(budget / 2);
      const tailLen = budget - headLen;
      const head = sliceHeadSafe(pendingAnnouncement.summaryHead, headLen);
      const tail = sliceTailSafe(pendingAnnouncement.summaryTail.trimEnd(), tailLen);
      summary = `${head}${TRUNCATION_MARKER}${tail}`.trim();
    }
    const status = pendingAnnouncement.failed ? 'failed' : pendingAnnouncement.killed ? 'interrupted' : 'completed';
    const taskStatus = pendingAnnouncement.failed ? 'failed' : pendingAnnouncement.killed ? 'killed' : 'completed';
    return settle(thread, pendingAnnouncement.taskId, status, taskStatus, summary, 'local_bash');
  }
  function safeSliceCut(text: string, overlap: number): number {
    let cut = text.length - overlap;
    if (cut > 0 && text.charCodeAt(cut - 1) >= 0xd800 && text.charCodeAt(cut - 1) <= 0xdbff) cut -= 1;
    return cut;
  }
  function feedStreamingCompletions(
    thread: string,
    scan: StreamingScanState,
    incoming: string,
    final: boolean,
    maxChars: number,
    overlap: number,
  ): BackgroundTaskDelta[] {
    const text = scan.buffer ? scan.buffer + incoming : incoming;
    if (!final && text.length <= maxChars) {
      scan.buffer = text;
      return [];
    }
    if (!threads.get(thread)?.size) {
      scan.buffer = '';
      scan.pending = undefined;
      return [];
    }
    const results: BackgroundTaskDelta[] = [];
    const limit = final ? text.length : safeSliceCut(text, overlap);
    let cursor = 0;

    if (COMPLETION_HINT.test(text)) {
      for (const match of text.matchAll(TASK_ANNOUNCEMENT_RE)) {
        const index = match.index!;
        if (index >= limit) break;
        if (scan.pending) {
          if (index > cursor) appendPendingResult(scan.pending, text.slice(cursor, index));
          results.push(...finalizePendingAnnouncement(thread, scan.pending));
          scan.pending = undefined;
        }
        scan.pending = {
          taskId: match[1],
          failed: match[2].toLowerCase() === 'failed',
          killed: /was canceled|was killed|terminated/i.test(match[2]),
          summaryHead: '',
          summaryTail: '',
          truncated: false,
          flagTail: '',
        };
        cursor = index + match[0].length;
      }
      for (const match of text.matchAll(SUBAGENT_IDLE_RE)) {
        if (match.index! >= limit) break;
        results.push(...settle(thread, match[1], 'completed', 'completed', undefined, 'local_subagent'));
      }
    }

    if (final) {
      if (scan.pending) {
        if (cursor < text.length) appendPendingResult(scan.pending, text.slice(cursor));
        results.push(...finalizePendingAnnouncement(thread, scan.pending));
        scan.pending = undefined;
      }
      scan.buffer = '';
    } else {
      const keepFrom = Math.max(limit, cursor);
      if (scan.pending && cursor < limit) {
        appendPendingResult(scan.pending, text.slice(cursor, limit));
      }
      if (threads.get(thread)?.size) {
        scan.buffer = text.slice(keepFrom);
      } else {
        scan.buffer = '';
        scan.pending = undefined;
      }
    }
    return results;
  }
  function consumeTranscriptChunk(
    thread: string,
    path: string,
    state: TranscriptWatcherState,
    chunk: string,
    remaining: boolean,
  ): BackgroundTaskDelta[] {
    const deltas: BackgroundTaskDelta[] = [];
    const plainLines: string[] = [];
    const flushPlain = (final = true) => {
      if (!plainLines.length && !state.plainScan) return;
      const scan = state.plainScan ??= { buffer: '' };
      const block = plainLines.length ? plainLines.join('\n') + '\n' : '';
      plainLines.length = 0;
      deltas.push(...feedStreamingCompletions(thread, scan, block, final, maxLineChars, lineOverlap));
      if (final) state.plainScan = undefined;
    };
    const feedOversized = (raw: string, final: boolean) => {
      const oversized = state.oversized ??= { prefix: '' };
      if (!oversized.kind) {
        raw = oversized.prefix + raw;
        const start = raw.replace(/^[ \t\r]*/, '');
        if (!start) return;
        const opener = start[0];
        const next = start.slice(1).replace(/^[ \t\r]*/, '');
        if (!final && (
          ((opener === '{' || opener === '[') && !next) ||
          (opener === '[' && ['true', 'false', 'null'].some(literal => literal.startsWith(next)))
        )) {
          oversized.prefix = opener + next;
          return;
        }
        // Brackets also introduce plain log prefixes such as [INFO].
        const json = opener === '"' ||
          (opener === '{' && /^["}]/.test(next)) ||
          (opener === '[' && JSON_ARRAY_START.test(next));
        oversized.kind = json ? 'json' : 'plain';
        oversized.prefix = '';
      }
      if (oversized.kind === 'plain') {
        flushPlain(false);
        const scan = state.plainScan ??= { buffer: '' };
        deltas.push(...feedStreamingCompletions(thread, scan, final ? raw + '\n' : raw, false, maxLineChars, lineOverlap));
        return;
      }
      flushPlain();
      if (disposed || watchers.get(thread)?.get(path) !== state) return;
      const json = oversized.json ??= { frames: [], skipDepth: 0, key: '', escape: '', hasText: false, done: false, invalid: false };
      const text = readTranscriptJson(json, raw, maxLineChars);
      if (!json.invalid) {
        const scan = oversized.scan ??= { buffer: '' };
        deltas.push(...feedStreamingCompletions(thread, scan, text, final && json.done, maxLineChars, lineOverlap));
      }
    };
    let pos = 0;
    while (pos < chunk.length) {
      if (disposed || watchers.get(thread)?.get(path) !== state) break;
      const nl = chunk.indexOf('\n', pos);
      const final = nl !== -1;
      const line = state.partial + chunk.slice(pos, final ? nl : chunk.length);
      pos = final ? nl + 1 : chunk.length;
      state.partial = '';
      if (state.oversized || line.length > maxLineChars) {
        feedOversized(line, final);
        if (final) state.oversized = undefined;
      } else if (!final) {
        state.partial = line;
      } else if (line && (state.plainScan || plainLines.length || COMPLETION_HINT.test(line) || line.includes('\\u'))) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          plainLines.push(line);
          continue;
        }
        flushPlain();
        if (disposed || watchers.get(thread)?.get(path) !== state) break;
        const extracted = extractTranscriptText(parsed);
        if (COMPLETION_HINT.test(extracted)) {
          deltas.push(...inspectTextForCompletions(thread, extracted));
        }
      }
    }
    if (!disposed && watchers.get(thread)?.get(path) === state) flushPlain(!remaining && !state.partial && !state.oversized);
    return deltas;
  }
  function scheduleCatchUp() {
    if (catchUpTimer || disposed || !watchers.size) return;
    catchUpTimer = setImmediate(() => {
      catchUpTimer = undefined;
      if (!disposed && watchers.size) poll();
    });
    catchUpTimer.unref?.();
  }
  function poll() {
    if (catchUpTimer) { clearImmediate(catchUpTimer); catchUpTimer = undefined; }
    if (disposed || !watchers.size) return;
    let hasMore = false;
    for (const [thread, paths] of watchers) for (const [path, state] of paths) {
      if (disposed) return;
      let fd: number | undefined;
      let chunk = '';
      let remaining = false;
      try {
        fd = openSync(path, 'r');
        const size = fstatSync(fd).size;
        if (size < state.offset) {
          state.offset = 0;
          state.partial = '';
          state.oversized = undefined;
          state.plainScan = undefined;
          state.decoder = new StringDecoder('utf8');
        }
        if (size > state.offset) {
          const toRead = Math.min(size - state.offset, maxReadBytes);
          readBuffer ??= Buffer.allocUnsafe(maxReadBytes);
          const count = readSync(fd, readBuffer, 0, toRead, state.offset);
          state.offset += count;
          if (count > 0) chunk = state.decoder.write(readBuffer.subarray(0, count));
          remaining = count > 0 && state.offset < size;
        }
      } catch { /* The CLI may not have created the transcript yet. */ }
      finally { if (fd !== undefined) closeSync(fd); }
      if (chunk) {
        const deltas = consumeTranscriptChunk(thread, path, state, chunk, remaining);
        if (deltas.length) options.onAsyncDeltas?.(thread, deltas);
      }
      if (remaining && !disposed && watchers.get(thread)?.get(path) === state) hasMore = true;
    }
    if (hasMore) scheduleCatchUp();
  }
  function handleToolEventForThread(thread: string, event: RetainedToolEvent): BackgroundTaskDelta[] {
    if (disposed) return [];
    // A failed run_command event with empty/whitespace output is the exact signature of the
    // "silent give-up" turn: record it even though no background task is registered for it.
    if (event.status === 'failed') {
      const inferred = inferAntigravityToolName(event as any);
      const name = inferred ?? [event.title, event.kind].find(v => typeof v === 'string' && v.trim()) ?? '';
      if (name === 'run_command' && !extractToolOutputText(event).trim()) {
        silentState(thread).emptyFailedCommand = true;
      }
    }
    if (event.status !== 'completed') return [];
    const input = event.rawInput ?? {};
    const text = extractToolOutputText(event);
    const inferred = inferAntigravityToolName(event as any);
    const name = (inferred && /^(run_command|schedule|invoke_subagent|manage_task|manage_subagents)$/.test(inferred) ? inferred : undefined)
      ?? [event.title, event.kind].find(v => /^(run_command|schedule|invoke_subagent|manage_task|manage_subagents)$/.test(v ?? '')) ?? '';
    const action = String(input.Action ?? '').toLowerCase();
    const results: BackgroundTaskDelta[] = [];
    const outputTruncated = Boolean((event as RetainedToolEvent).outputTruncated);
    if (name === 'manage_task') {
      const id = first(input.TaskId);
      if (action === 'kill' && id) return settle(thread, id, 'interrupted', 'killed', text, 'local_bash');
      if (action === 'status' && id) {
        const status = event.outputTruncated ? event.taskStatusFromOutput : parseTaskStatus(text);
        if (status && status !== 'running') return settle(thread, id, status, status === 'interrupted' ? 'killed' : status, text, 'local_bash');
      }
      if (action === 'list' && !outputTruncated && /No running tasks|\| Start Time \| Task ID \| Tool \| Description \|/i.test(text)) {
        for (const task of getActiveTasks(thread)) {
          const present = containsTaskToken(text, task.taskId) || containsTaskToken(text, task.taskId.split('/').pop()!);
          if (task.taskType === 'local_bash' && !present) results.push(...settle(thread, task.taskId, 'completed', 'completed', text, task.taskType));
        }
      }
    }
    if (name === 'manage_subagents') {
      const empty = !outputTruncated && (/no active (?:direct )?subagents/i.test(text) || /^\s*\[\s*\]\s*$/.test(text)
        || (Array.isArray(event.rawOutput) && event.rawOutput.length === 0));
      for (const task of getActiveTasks(thread)) {
        if (task.taskType !== 'local_subagent') continue;
        const kill = action === 'kill_all' || (action === 'kill' && Array.isArray(input.ConversationIds) && input.ConversationIds.includes(task.taskId));
        const line = text.split('\n').find(line => containsTaskToken(line, task.taskId));
        if (kill || (action === 'list' && (empty || (line && /\bidle\b|\bdone\b|\bcompleted\b|\bkilled\b|\bstopped\b/i.test(line))))) results.push(...settle(thread, task.taskId, kill ? 'interrupted' : 'completed', kill ? 'killed' : 'completed', text, task.taskType));
      }
    }
    const agent = name === 'invoke_subagent';
    const raw = event.rawOutput as Record<string, unknown> | undefined;
    // Daemons and schedules (timers, recurring cron jobs) are meant to outlive the turn.
    const daemon = !agent && (name === 'schedule' || input.IsDaemon === true || input.IsDaemon === 'true');
    const spawnedId = /\bSubagent spawned\b/i.test(text) ? /\bconversationId:[ \t]*([^\s,]+)/i.exec(text)?.[1] : undefined;
    const id = agent ? first(raw?.conversationId, /"conversationId"\s*:\s*"([^"]+)"/.exec(text)?.[1], spawnedId)
      : /^(run_command|schedule)$/.test(name) ? first(/Tool is running as a background task with task id:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1], /Background command ID:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1]) : '';
    if (!id) return results;
    const title = /^(run_command|schedule|invoke_subagent)$/.test(event.title ?? '') ? '' : event.title;
    const outputFile = first(/Task logs are available at:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1]);
    const task: BackgroundTask = { taskId: id, taskType: agent ? 'local_subagent' : 'local_bash', parentToolCallId: event.toolCallId,
      description: agent ? first(input.Role, input.TypeName, title, id) : first(input.toolSummary, /Task Description:[ \t]*([^\s\r\n][^\r\n]*)/.exec(text)?.[1], input.CommandLine, input.command, input.Prompt, title, id),
      ...(outputFile ? { outputFile: normalizeFileUri(outputFile), transcriptPath: deriveTranscriptPathFromLogFile(outputFile) ?? undefined } : {}), startedAt: Date.now(),
      ...(daemon ? { daemon } : {}) };
    return [...results, ...registerTask(thread, task)];
  }
  function registerTask(thread: string, task: BackgroundTask): BackgroundTaskDelta[] {
    if (disposed) return [];
    const tasks = threads.get(thread) ?? new Map<string, BackgroundTask>();
    if (tasks.has(taskKey(task))) return [];
    tasks.set(taskKey(task), task); threads.set(thread, tasks);
    persistTasks(thread, [task], false);
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
    return [delta(task)];
  }
  /**
   * The CLI can end its prompt while a `run_command` call is still `in_progress`. The SDK bridge
   * then force-closes the item (status `completed`, no output, no `noTurnFallback`) although the
   * command keeps running, and the real result only arrives as a `tool_call_update` after the
   * turn boundary. Track such a call as a background task so the turn can be held and the late
   * result settles it.
   */
  function registerOrphanCommand(thread: string, event: RecordedToolEvent): BackgroundTaskDelta[] {
    const name = inferAntigravityToolName(event as any) ?? [event.title, event.kind].find(v => v === 'run_command');
    if (name !== 'run_command') return [];
    const input = event.rawInput ?? {};
    return registerTask(thread, {
      taskId: event.toolCallId, taskType: 'local_bash', parentToolCallId: event.toolCallId,
      description: first(input.toolSummary, input.CommandLine, input.command, event.title, event.toolCallId),
      startedAt: Date.now(), orphan: true,
      ...(input.IsDaemon === true || input.IsDaemon === 'true' ? { daemon: true } : {}),
    });
  }
  function settleOrphanCommand(thread: string, event: RetainedToolEvent): BackgroundTaskDelta[] {
    const task = threads.get(thread)?.get(taskKey({ taskType: 'local_bash', taskId: event.toolCallId }));
    if (!task?.orphan || !TERMINAL_TOOL_STATUS.test(event.status ?? '')) return [];
    const text = extractToolOutputText(event).trim();
    const failed = event.status === 'failed' || (event.outputTruncated ? event.commandFailed : /command exited with code [1-9]\d*/i.test(text));
    const killed = !failed && /cancel/i.test(event.status ?? '');
    return settle(thread, task.taskId, failed ? 'failed' : killed ? 'interrupted' : 'completed',
      failed ? 'failed' : killed ? 'killed' : 'completed', text || undefined, 'local_bash');
  }

  // ---- Turn hold ----------------------------------------------------------------------------
  // The CLI detaches any command that outlives its 10 s synchronous wait and tells the model to
  // stop calling tools until it is notified. The prompt then ends with `end_turn`, the bridge
  // emits a completed `turn.boundary`, and BB marks the thread idle and notifies parent threads
  // although the agent is only waiting. When the task exits, the CLI wakes the model with an
  // unsolicited turn. So while blocking work runs, the completed boundary is held back; the
  // reactive turn's `turn.open` is absorbed into the still-open BB turn, and the boundary that
  // finally reaches BB is the one that ends the agent's real work.
  interface TurnHold {
    /** Held `turn.boundary`; present while BB's turn is kept open. */
    boundary?: TurnBoundaryDelta;
    /** A bridge turn (reactive wakeup or steer prompt) was absorbed into the held turn. */
    bridgeTurnOpen: boolean;
    /** BB's turn was closed while an absorbed bridge turn was still open; drop that turn's boundary. */
    dropNextBoundary: boolean;
    /** Let an active bridge prompt finish after the idle wait budget expires. */
    finishAtBoundary?: boolean;
    /** JSON-RPC id of a steer rewritten into turn/start, until the bridge answers it. */
    steerRequestId?: string | number;
    graceTimer?: ReturnType<typeof setTimeout>;
    capTimer?: ReturnType<typeof setTimeout>;
  }
  const holds = new Map<string, TurnHold>();
  const holdTurns = options.holdTurns !== false;
  const settleGraceMs = Math.max(0, options.holdSettleGraceMs ?? DEFAULT_HOLD_SETTLE_GRACE_MS);
  const maxHoldMs = Math.max(0, options.maxTurnHoldMs ?? DEFAULT_MAX_TURN_HOLD_MS);
  /** Tasks whose end the tracker sees itself (transcript watcher or late tool update). */
  function observable(thread: string, task: BackgroundTask): boolean {
    return task.orphan === true || (!!task.transcriptPath && !!watchers.get(thread)?.has(task.transcriptPath));
  }
  function holdBlockers(thread: string): BackgroundTask[] {
    return [...(threads.get(thread)?.values() ?? [])].filter(task => !task.daemon && !task.holdExempt);
  }
  function clearHoldTimers(hold: TurnHold) {
    if (hold.graceTimer) clearTimeout(hold.graceTimer);
    if (hold.capTimer) clearTimeout(hold.capTimer);
    hold.graceTimer = undefined; hold.capTimer = undefined;
  }
  /** After a hold ends, never wait again on tasks it could not watch (or on anything, after the cap). */
  function exemptAfterHold(thread: string, all: boolean) {
    for (const task of threads.get(thread)?.values() ?? []) if (all || !observable(thread, task)) task.holdExempt = true;
  }
  function closeTurn(thread: string, boundary: TurnBoundaryDelta): TrackerDelta[] {
    const injected = handleTurnBoundary(thread, boundary.status);
    return [...(typeof injected === 'string' ? silentTurnInjection(injected) : []), boundary];
  }
  /** Ends an active hold and returns the deltas that close BB's turn ([] when nothing is held). */
  function releaseHold(thread: string, status?: string, capped = false): TrackerDelta[] {
    const hold = holds.get(thread);
    if (!hold?.boundary) return [];
    const boundary: TurnBoundaryDelta = { ...hold.boundary, ...(status ? { status } : {}) };
    clearHoldTimers(hold);
    hold.boundary = undefined;
    hold.dropNextBoundary = hold.bridgeTurnOpen;
    hold.bridgeTurnOpen = false;
    if (!hold.dropNextBoundary) holds.delete(thread);
    exemptAfterHold(thread, capped);
    return closeTurn(thread, boundary);
  }
  function releaseHoldAsync(thread: string, capped: boolean) {
    if (disposed) return;
    const deltas = releaseHold(thread, undefined, capped);
    if (deltas.length) options.onAsyncDeltas?.(thread, deltas);
  }
  function beginHold(thread: string, boundary: TurnBoundaryDelta) {
    const hold: TurnHold = { boundary, bridgeTurnOpen: false, dropNextBoundary: false };
    holds.set(thread, hold);
    hold.capTimer = setTimeout(() => {
      if (hold.bridgeTurnOpen) hold.finishAtBoundary = true;
      else releaseHoldAsync(thread, true);
    }, maxHoldMs);
    hold.capTimer.unref?.();
  }
  /**
   * Every blocking task settled but no reactive turn has started: give the CLI a grace period to
   * wake the model, then release the boundary (silent exit, missed wakeup, or a dead CLI).
   */
  function armSettleGrace(thread: string) {
    const hold = holds.get(thread);
    if (!hold?.boundary || hold.bridgeTurnOpen || hold.graceTimer || holdBlockers(thread).length) return;
    hold.graceTimer = setTimeout(() => {
      hold.graceTimer = undefined;
      if (holds.get(thread) === hold && hold.boundary && !hold.bridgeTurnOpen && !holdBlockers(thread).length) releaseHoldAsync(thread, false);
    }, settleGraceMs);
    hold.graceTimer.unref?.();
  }
  /** Returns false when a bridge `turn.open` must be absorbed into the held BB turn. */
  function routeTurnOpen(thread: string): boolean {
    const hold = holds.get(thread);
    if (hold?.boundary) {
      exemptAfterHold(thread, false);
      hold.bridgeTurnOpen = true;
      if (hold.graceTimer) { clearTimeout(hold.graceTimer); hold.graceTimer = undefined; }
      return false;
    }
    // A new bridge turn supersedes one whose boundary was still owed after an early release.
    if (hold?.dropNextBoundary) holds.delete(thread);
    return true;
  }
  function routeTurnBoundary(thread: string, boundary: TurnBoundaryDelta): 'forward' | 'hold' | 'drop' {
    const hold = holds.get(thread);
    if (hold && !hold.boundary && hold.dropNextBoundary) { holds.delete(thread); return 'drop'; }
    if (hold?.boundary) {
      // After an absorbed turn, only keep waiting on work whose end is observable: a reactive
      // wakeup is itself the CLI's notice that unobservable work finished.
      if (hold.finishAtBoundary) exemptAfterHold(thread, true);
      hold.bridgeTurnOpen = false;
      if (boundary.status === 'completed' && holdBlockers(thread).length) {
        hold.boundary = boundary;
        return 'hold';
      }
      clearHoldTimers(hold); holds.delete(thread);
      exemptAfterHold(thread, false);
      return 'forward';
    }
    if (holdTurns && boundary.status === 'completed' && holdBlockers(thread).length) { beginHold(thread, boundary); return 'hold'; }
    return 'forward';
  }
  /**
   * Matches the bridge's answer to a steer that was rewritten into turn/start. A rejected prompt
   * (for example the CLI session died while the turn was held) will never open a turn, so the
   * held turn is released instead of waiting for the cap.
   */
  function steerResponse(message: any): { thread: string; failed: boolean } | null {
    if (!message || message.method !== undefined || (typeof message.id !== 'string' && typeof message.id !== 'number')) return null;
    for (const [thread, hold] of holds) {
      if (hold.steerRequestId !== message.id) continue;
      hold.steerRequestId = undefined;
      const failed = message.error !== undefined && message.result === undefined;
      if (failed) hold.bridgeTurnOpen = false;
      return { thread, failed };
    }
    return null;
  }
  function deltaLines(thread: string, deltas: TrackerDelta[]): string[] {
    return deltas.length ? [JSON.stringify({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: thread, deltas } })] : [];
  }
  /** Abandons hold state without emitting anything (the turn is settled some other way). */
  function dropHold(thread: string) {
    const hold = holds.get(thread);
    if (hold) { clearHoldTimers(hold); holds.delete(thread); }
  }
  function getActiveTasks(thread: string): ReadonlyArray<BackgroundTask> { return [...(threads.get(thread)?.values() ?? [])].map(task => ({ ...task })); }
  function clearThread(thread: string, emitCloseDeltas = false): BackgroundTaskDelta[] {
    if (disposed) return [];
    if (holds.get(thread)?.boundary) dropHold(thread);
    const active = getActiveTasks(thread);
    const results = emitCloseDeltas ? active.map(task => delta(task, 'interrupted', 'stopped')) : [];
    threads.delete(thread); threadTools.delete(thread); streamBuffers.delete(thread); silentTurns.delete(thread); syncPolling();
    pendingReconciliations.delete(thread);
    if (startupLoadPending) clearedBeforeStartupLoad.add(thread);
    const recovered = [...initialRecords.values()].filter(record => record.threadId === thread);
    persistTasks(thread, [...recovered, ...active], true);
    return results;
  }
  function handleInbound(request: unknown): { request: unknown; deltas: TrackerDelta[] } {
    if (disposed) return { request, deltas: [] };
    const message = request as { method?: string; params?: { threadId?: string } } | null;
    if (!message || typeof message.params?.threadId !== 'string') return { request, deltas: [] };
    const thread = message.params.threadId;
    const method = message.method ?? '';
    if (method === 'thread/stop' || method === 'thread/discard') {
      // Stop never waits on a held turn: close it as interrupted. If the bridge still has an
      // absorbed turn open, it emits its own interrupted boundary, which is then dropped.
      const released = releaseHold(thread, 'interrupted');
      return { request, deltas: [...clearThread(thread, true), ...released] };
    }
    const hold = holds.get(thread);
    if (method === 'turn/steer' && hold?.boundary && !hold.bridgeTurnOpen) {
      // BB still shows the held turn as running and steers it, but the bridge has no prompt to
      // steer and would reject the input as a stale turn. Start a prompt instead; its turn.open
      // is absorbed, so the input continues the same BB turn.
      hold.bridgeTurnOpen = true;
      const id = (message as { id?: unknown }).id;
      if (typeof id === 'string' || typeof id === 'number') hold.steerRequestId = id;
      if (hold.graceTimer) { clearTimeout(hold.graceTimer); hold.graceTimer = undefined; }
      return { request: { ...message, method: 'turn/start' }, deltas: [] };
    }
    // Restart reconciliation hook: BB re-issues `thread/resume` (and a `turn/start` for the
    // resumed turn) to every connected host, so this runs exactly once per resumed thread and
    // before the CLI sees the resume. Cleaner than keying off processStdoutLine activity,
    // which also arrives mid-turn for cases that are not resumes at all.
    // A new turn while a turn is held closes the held one first, keeping turn state balanced.
    if (method === 'turn/start') {
      exemptAfterHold(thread, true);
      // An active prompt may still send text before the SDK closes it.
      if (hold?.bridgeTurnOpen) hold.finishAtBoundary = true;
      const released = hold?.bridgeTurnOpen ? [] : releaseHold(thread);
      return { request, deltas: [...released, ...reconcilePersisted(thread)] };
    }
    if (method === 'thread/resume') return { request, deltas: reconcilePersisted(thread) };
    return { request, deltas: [] };
  }
  // Startup load: snapshot which records predate this host process (only those are eligible for
  // reconciliation) and flush a GC pass so records older than the max age cannot accumulate
  // across restarts, even if no traffic ever arrives. Persisted records are intentionally NOT
  // dropped on dispose(): a graceful host exit is indistinguishable from a crash here, and the
  // next resume must still report the tasks as interrupted.
  const initialRecords = new Map<string, PersistedBackgroundTask>();
  if (persistPath) {
    const locked = withTaskStateLock(persistPath, () => {
      const state = loadTaskState(persistPath, maxAge, fsOps);
      let gcWriteError: 'none' | 'transient' | 'failed' = 'none';
      if (state.ioError === 'none' && state.needsWrite) {
        const writeResult = writeTaskState(persistPath, state.tasks, fsOps);
        if (writeResult !== 'saved') gcWriteError = writeResult;
      }
      return { state, gcWriteError };
    }, fsOps);
    const state = locked.status === 'acquired' ? locked.value.state : loadTaskState(persistPath, maxAge, fsOps);
    const gcWriteError = locked.status === 'acquired' ? locked.value.gcWriteError : 'none';
    if (state.ioError === 'none') {
      populateInitialRecords(state.tasks, false);
      if (state.needsWrite && (
        locked.status === 'contended' ||
        locked.status === 'transient' ||
        (locked.status === 'acquired' && gcWriteError === 'transient')
      )) {
        startupGcPending = true;
        if (locked.status === 'transient' || (locked.status === 'acquired' && gcWriteError === 'transient')) transientRetryAttempt = 1;
        schedulePersistRetry();
      }
    } else if (state.ioError === 'transient') {
      startupLoadPending = true;
      startupGcPending = true;
      transientRetryAttempt = 1;
      schedulePersistRetry();
    }
  }
  function retainThreadTool(thread: string, id: string, event: RecordedToolEvent) {
    const compacted = compactToolEvent(event, maxToolOutputChars);
    let tools = threadTools.get(thread);
    if (!tools) { tools = new Map(); threadTools.set(thread, tools); }
    if (tools.has(id)) tools.delete(id);
    tools.set(id, compacted);
    if (tools.size > maxToolsPerThread) {
      const activeTasks = threads.get(thread);
      for (const key of tools.keys()) {
        if (tools.size <= maxToolsPerThread) break;
        if (key === id) continue;
        if (activeTasks?.get(taskKey({ taskType: 'local_bash', taskId: key }))?.orphan) continue;
        tools.delete(key);
      }
      while (tools.size > maxToolsPerThread) {
        const oldest = tools.keys().next().value;
        if (oldest === undefined || oldest === id) break;
        tools.delete(oldest);
      }
    }
  }
  return {
    recordToolEvent(event: RecordedToolEvent) {
      if (disposed) return;
      const compacted = compactToolEvent(event, maxToolOutputChars);
      let queue = pending.get(compacted.toolCallId);
      if (queue) {
        pending.delete(compacted.toolCallId);
      } else {
        queue = [];
      }
      queue.push(compacted);
      pending.set(compacted.toolCallId, queue);
      pendingCount += 1;
      while (pendingCount > maxPendingEvents) {
        // Keep terminal updates available for correlation when one noisy call floods the queue.
        let evicted = false;
        for (const [key, events] of pending) {
          const index = events.findIndex(update => !TERMINAL_TOOL_STATUS.test(update.status ?? ''));
          if (index < 0) continue;
          events.splice(index, 1);
          if (!events.length) pending.delete(key);
          evicted = true;
          break;
        }
        if (!evicted) {
          const first = pending.entries().next().value;
          if (!first) break;
          first[1].shift();
          if (!first[1].length) pending.delete(first[0]);
        }
        pendingCount -= 1;
      }
    },
    handleToolEventForThread,
    inspectTextForCompletions(thread: string, text: string): BackgroundTaskDelta[] {
      return inspectTextForCompletions(thread, text);
    },
    getActiveTasks, clearThread,
    processStdoutLine(line: string): string[] {
      if (disposed) return [line];
      let message;
      try { message = JSON.parse(line); } catch { return [line]; }
      const response = steerResponse(message);
      if (response) return response.failed ? [line, ...deltaLines(response.thread, releaseHold(response.thread, 'interrupted'))] : [line];
      const params = message?.params;
      if (message?.method !== 'thread/delta' || typeof params?.threadId !== 'string' || !Array.isArray(params.deltas)) return [line];
      const extra: BackgroundTaskDelta[] = [];
      // Injected silent-turn warnings must precede the turn boundary in the delta list
      // (after the boundary the host has already closed the turn and would drop them),
      // so the outgoing deltas are rebuilt instead of blindly appended.
      const ordered: unknown[] = [];
      let boundarySeen = false;
      let modified = false;
      for (const entry of params.deltas) {
        const update = entry?.noTurnFallback?.raw?.params?.update;
        const id = entry?.key?.providerItemId ?? update?.toolCallId;
        if (typeof id === 'string') {
          const queue = pending.get(id);
          const queued = queue?.shift();
          if (queued) pendingCount = Math.max(0, pendingCount - 1);
          if (queue && !queue.length) pending.delete(id);
          // The fallback update belongs to this exact thread; prefer it over the unscoped hook.
          const event = update && typeof update === 'object' ? { ...update, toolCallId: id } as RecordedToolEvent : queued;
          const tools = threadTools.get(params.threadId);
          const known = tools?.get(id);
          const merged = event ? mergeToolEvent(known, event) : known;
          const isOrphanFlush = Boolean(
            merged && entry?.kind === 'item.close' && !entry.noTurnFallback && entry.status === 'completed' && !TERMINAL_TOOL_STATUS.test(merged.status ?? ''),
          );
          const isTerminalEvent = Boolean(
            event && merged && (TERMINAL_TOOL_STATUS.test(merged.status ?? '') || entry?.kind === 'item.close'),
          );
          if (isOrphanFlush && merged) {
            // SDK 0.6.178 flushes unfinished commands this way. The ACP integration test covers this shape.
            extra.push(...registerOrphanCommand(params.threadId, merged));
          } else if (isTerminalEvent && merged) {
            extra.push(...settleOrphanCommand(params.threadId, merged));
            extra.push(...handleToolEventForThread(params.threadId, merged));
          }
          const isActiveOrphan = Boolean(threads.get(params.threadId)?.get(taskKey({ taskType: 'local_bash', taskId: id }))?.orphan);
          const shouldEvict =
            Boolean(merged && TERMINAL_TOOL_STATUS.test(merged.status ?? '')) ||
            (entry?.kind === 'item.close' && !isActiveOrphan && !event) ||
            (isOrphanFlush && !isActiveOrphan);
          if (shouldEvict) {
            if (tools) {
              tools.delete(id);
              if (!tools.size) threadTools.delete(params.threadId);
            }
          } else if (event && merged) {
            retainThreadTool(params.threadId, id, merged);
          }
        }
        if (entry?.settlesTurn === true) { exemptAfterHold(params.threadId, true); dropHold(params.threadId); } // e.g. provider.error: BB settles the turn itself.
        if (entry?.kind === 'turn.open' && !routeTurnOpen(params.threadId)) { modified = true; continue; }
        if (entry?.kind === 'item.textDelta' && typeof entry.text === 'string') {
          if (threads.get(params.threadId)?.size) {
            let scan = streamBuffers.get(params.threadId);
            if (!scan) { scan = { buffer: '' }; streamBuffers.set(params.threadId, scan); }
            extra.push(...feedStreamingCompletions(params.threadId, scan, entry.text, false, maxStreamChars, streamOverlap));
            if (!threads.get(params.threadId)?.size) streamBuffers.delete(params.threadId);
          } else {
            streamBuffers.delete(params.threadId);
          }
          // Visible agent text (not reasoning) marks the turn as non-silent.
          if (entry.text.trim() && entry.channel !== 'reasoningText' && entry.channel !== 'reasoningSummary') {
            silentState(params.threadId).agentText = true;
          }
        } else if (typeof entry?.text === 'string') {
          extra.push(...inspectTextForCompletions(params.threadId, entry.text));
        }
        if (entry?.kind === 'item.textClose' || entry?.kind === 'turn.boundary') {
          const scan = streamBuffers.get(params.threadId);
          streamBuffers.delete(params.threadId);
          if (scan) extra.push(...feedStreamingCompletions(params.threadId, scan, '', true, maxStreamChars, streamOverlap));
        }
        if (entry?.kind === 'item.textClose' && typeof entry.text === 'string' && entry.text.trim() && entry.channel !== 'reasoningText' && entry.channel !== 'reasoningSummary') {
          silentState(params.threadId).agentText = true;
        }
        if (entry?.kind === 'item.open' && entry?.item?.type === 'agentMessage' && typeof entry.item.text === 'string' && entry.item.text.trim()) {
          silentState(params.threadId).agentText = true;
        }
        if (entry?.kind === 'item.close' && entry?.status === 'failed' && (entry?.item?.type === 'command' || entry?.key?.channel === 'command')) {
          // Failed command item with empty/whitespace-only output: the "silent give-up" signature.
          const outputs = [entry?.item?.aggregatedOutput, entry?.aggregatedOutput, entry?.resultText];
          if (outputs.every(value => value == null || (typeof value === 'string' && value.trim() === ''))) {
            silentState(params.threadId).emptyFailedCommand = true;
          }
        }
        if (entry?.kind === 'turn.boundary') {
          // Held or dropped boundaries do not end the logical turn, so silent-turn state carries over.
          ordered.push(...extra.splice(0));
          const route = routeTurnBoundary(params.threadId, entry);
          if (route !== 'forward') { modified = true; continue; }
          if (!boundarySeen) {
            boundarySeen = true;
            const injectedText = handleTurnBoundary(params.threadId, entry?.status);
            if (typeof injectedText === 'string') ordered.push(...silentTurnInjection(injectedText));
          }
        }
        ordered.push(entry);
        for (const text of [entry?.resultText, entry?.aggregatedOutput, entry?.message, entry?.delta?.text, entry?.item?.output, entry?.item?.text]) {
          if (typeof text === 'string') extra.push(...inspectTextForCompletions(params.threadId, text));
        }
      }
      ordered.push(...extra);
      if (!modified && ordered.length === params.deltas.length) return [line];
      if (!ordered.length) return []; // Everything in the line was held or absorbed.
      params.deltas = ordered; return [JSON.stringify(message)];
    },
    /** Routes an inbound bridge request; may rewrite it (steer into a held turn) and returns deltas to emit first. */
    handleInbound,
    handleInboundRequest(request: unknown): TrackerDelta[] { return handleInbound(request).deltas; },
    /** Whether a completed boundary is currently held for the thread. */
    isHoldingTurn(thread: string): boolean { return holds.get(thread)?.boundary !== undefined; },
    dispose() {
      disposed = true;
      clearPersistRetry();
      startupLoadPending = false;
      startupGcPending = false;
      initialRecords.clear();
      pendingWrites.clear();
      pendingReconciliations.clear();
      localTouchedBeforeStartupLoad.clear();
      clearedBeforeStartupLoad.clear();
      for (const hold of holds.values()) clearHoldTimers(hold);
      holds.clear(); threads.clear(); pending.clear(); pendingCount = 0; threadTools.clear(); streamBuffers.clear(); silentTurns.clear(); watchers.clear();
      if (timer) { clearInterval(timer); timer = undefined; }
      if (catchUpTimer) { clearImmediate(catchUpTimer); catchUpTimer = undefined; }
      readBuffer = undefined;
    },
  };
}
