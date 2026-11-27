import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { isStandaloneBuiltinCompactCommand, threadStopParamsSchema, turnStartParamsSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { hostHomeDirectory } from "./cli.ts";

const sessionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const unconfirmed = "Antigravity did not confirm a new compaction checkpoint.";

interface PendingCheckpoint {
  requestId: string | number;
  path: string;
  offset: number;
  inode: bigint;
  started: boolean;
  stop?: { id: string | number; release: boolean };
}

// Read only the new records. Never publish conversation text in a diagnostic.
function hasCheckpoint(pending: PendingCheckpoint): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(pending.path, "r");
    const stat = fstatSync(fd, { bigint: true });
    const length = Number(stat.size) - pending.offset;
    if (stat.ino !== pending.inode || length <= 0 || length > 4 * 1024 * 1024) return false;
    const buffer = Buffer.alloc(length);
    if (readSync(fd, buffer, 0, length, pending.offset) !== length) return false;
    const records = buffer.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const request = records[0];
    const checkpoint = records.at(-1);
    return request?.type === "USER_INPUT" && request.source === "USER_EXPLICIT" &&
      typeof request.content === "string" && /^<USER_REQUEST>\s*\/compact\s*<\/USER_REQUEST>/.test(request.content) &&
      Number.isSafeInteger(request.step_index) &&
      records.slice(1, -1).every(row => row?.type === "SYSTEM_MESSAGE" && row.source === "SYSTEM") &&
      checkpoint?.type === "CHECKPOINT" && checkpoint.source === "SYSTEM" && checkpoint.status === "DONE" &&
      checkpoint.step_index === request.step_index + records.length - 1;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createCompactionVerifier(home = hostHomeDirectory()) {
  const pending = new Map<string, PendingCheckpoint>();
  // The SDK can await session options before marking a turn active.
  const starting = new Map<string | number, string>();
  return {
    prepare(request: any, routed = false): string | undefined {
      if (request?.method === "thread/stop") {
        const attempt = pending.get(request.params?.threadId);
        if (attempt && !attempt.stop && threadStopParamsSchema.safeParse(request.params).success) {
          // The SDK acknowledges redundant stops before the original stop has settled.
          attempt.stop = { id: request.id, release: request.params.intent === "release" };
        }
      }
      if (request?.method !== "turn/start") return;
      const params = turnStartParamsSchema.safeParse(request.params);
      if (!params.success || (typeof request.id !== "string" && typeof request.id !== "number")) return;
      const { threadId, providerThreadId } = params.data;
      if (pending.has(threadId)) return "Manual compaction is already in progress.";
      if (!isStandaloneBuiltinCompactCommand(params.data.input)) {
        starting.set(request.id, threadId);
        return;
      }
      if (routed) return "Manual compaction currently requires the default Antigravity profile.";
      if ([...starting.values()].includes(threadId)) return "Wait for the current turn to finish before compacting.";
      if (!home || !sessionIdPattern.test(providerThreadId)) return unconfirmed;
      const path = join(home, ".gemini", "antigravity-cli", "brain", providerThreadId,
        ".system_generated", "logs", "transcript.jsonl");
      try {
        const stat = statSync(path, { bigint: true });
        if (!stat.isFile() || stat.size === 0n) return "Complete a conversation turn before compacting.";
        pending.set(threadId, { requestId: request.id, path, offset: Number(stat.size), inode: stat.ino, started: false });
      } catch {
        return "No readable Antigravity transcript. Complete a conversation turn before compacting.";
      }
    },
    verify(message: any) {
      if (message?.id !== undefined && (message.result || message.error)) starting.delete(message.id);
      if (!pending.size) return;
      if (message?.id !== undefined && (message.error || message.result?.ok)) {
        for (const [thread, attempt] of pending) {
          if ((message.error && attempt.requestId === message.id) ||
              (message.result?.ok && attempt.stop?.release && attempt.stop.id === message.id)) pending.delete(thread);
          else if (message.error && attempt.stop?.id === message.id) delete attempt.stop;
        }
      }
      if (message?.method !== "thread/delta") return;
      const { threadId, deltas } = message.params;
      const attempt = pending.get(threadId);
      if (!attempt || !Array.isArray(deltas)) return;
      if (deltas.some(delta => delta.kind === "item.open" && delta.key?.channel === "compaction")) attempt.started = true;
      if (!attempt.started) return;
      const boundary = deltas.find(delta => delta.kind === "turn.boundary");
      if (!boundary) return;
      pending.delete(threadId);
      const mark = deltas.findIndex(delta => delta.kind === "context.compacted");
      if (mark < 0 || hasCheckpoint(attempt)) return;
      deltas.splice(mark, 1);
      boundary.status = "failed";
      boundary.error = { message: unconfirmed };
      for (const delta of deltas) {
        if (delta.kind === "item.close" && delta.key?.channel === "compaction") delta.status = "failed";
      }
    },
  };
}
