import { experimental_acpLaunchSpecSchema, experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import {
  threadStartParamsSchema,
  threadResumeParamsSchema,
  turnStartParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ProviderHealthResult, ProviderInstallationStatus } from "@get-bb/plugin-sdk/provider-bridge";
import { createBackgroundTaskTracker, defaultBackgroundTaskStatePath } from "./background-tasks.ts";
import { ANTIGRAVITY_ACP_DIALECT_ID, applyThreadCommandDescriptions, onToolUpdate, registerAntigravityAcpDialect } from "./dialect.ts";
import { modeControlOutput } from "./mode-controls.ts";
import { mapPromptMode } from "./prompt-mode.ts";
import { interceptSubagentApproval, isSubagentApprovalForDisabledThread, transformSubagentRequest } from "./subagents.ts";
import { readAntigravityProviderUsage } from "./usage.ts";
import { prepareAntigravityProfile, resolveAntigravityLaunchSpec } from "./cli.ts";
import {
  ANTIGRAVITY_INVALID_PROFILE_MESSAGE,
  ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE,
  decodeProfileSessionId,
  encodeProfileSessionId,
  hashAntigravityProfile,
  matchesProfileSessionId,
} from "./profile-bindings.ts";
import { createCompactionVerifier } from "./compaction.ts";

registerAntigravityAcpDialect();

let rawStdoutWrite: typeof process.stdout.write | null = null;
const compaction = createCompactionVerifier();
export const backgroundTaskTracker = createBackgroundTaskTracker({
  persistPath: defaultBackgroundTaskStatePath(),
  onAsyncDeltas(threadId, deltas) {
    if (!deltas.length) return;
    const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
    write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId, deltas } })}\n`);
  },
});

onToolUpdate(event => {
  backgroundTaskTracker.recordToolEvent(event as any);
});

function parseUsageRequest(parsed: unknown): { id: string | number; command: string; cwd?: string; env?: Record<string, string> } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.method !== "provider/usage") return null;
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const params = record.params && typeof record.params === "object" ? (record.params as Record<string, unknown>) : undefined;
  const providerOptions =
    params?.providerOptions && typeof params.providerOptions === "object"
      ? (params.providerOptions as Record<string, unknown>)
      : undefined;
  const spec = experimental_acpLaunchSpecSchema.safeParse(providerOptions?.acpLaunchSpec);
  return {
    id,
    command: spec.success ? spec.data.command : "agy",
    cwd: spec.success ? spec.data.cwd : undefined,
    env: spec.success ? spec.data.env : undefined,
  };
}

function missingCliResponse(method: unknown) {
  switch (method) {
    case "provider/health":
      return { result: {
        supported: true,
        health: {
          status: "not_installed",
          statusMessage: null,
          accountEmail: null,
          planLabel: null,
          installedVersion: null,
          minimumSupportedVersion: null,
          canInstall: false,
          canUpdate: false,
          loginCommand: null,
        },
      } satisfies ProviderHealthResult };
    case "provider/usage":
      return { result: { supported: true, usage: { status: "not_installed" } } };
    case "provider/installation/status":
      return { result: {
        executableName: "agy",
        executablePath: null,
        installed: false,
        installSource: "notInstalled",
        currentVersion: null,
        latestVersion: null,
        minimumSupportedVersion: null,
        npmPackageName: null,
        npmGlobalPackageVersion: null,
        installAction: null,
        needsUpdate: false,
        versionUnsupported: false,
      } satisfies ProviderInstallationStatus };
    case "provider/installation/run":
      return { result: { available: false, message: "Antigravity CLI installation and updates are unavailable through BB." } };
    default:
      return { error: { code: -32000, message: "Antigravity CLI (agy) was not found on the agent host." } };
  }
}

let stdoutFilterInstalled = false;
const autoApproveThreads = new Map<string, boolean>();
const commandDescriptionsThreads = new Map<string, boolean>();
type PendingIdentity = { threadId: string; profileHash?: string; stop?: true };
type SessionIdentity = { profileHash?: string; sessionId: string };
const pendingIdentities = new Map<string | number, PendingIdentity>();
const activeIdentities = new Map<string, SessionIdentity>();
const pendingInputs = new Map<string | number, { threadId: string; clientRequestId: string; steer: boolean }>();
type ClosingSession = {
  id: string | number;
  line: string;
  pastEarlyAck: boolean;
  phase: "first-stop" | "waiting-for-input" | "final-stop";
};
const closingSessions = new Map<string, ClosingSession>();

function pendingIdentityForThread(threadId: string): PendingIdentity | undefined {
  for (const pending of pendingIdentities.values()) {
    if (pending.threadId === threadId) return pending;
  }
}

function profileError(message: string) {
  return { code: -32000, message };
}

function hasPendingRoutedWork(threadId: string): boolean {
  return [...pendingIdentities.values()].some(request =>
    request.threadId === threadId && !request.stop && request.profileHash !== undefined) ||
    [...pendingInputs.values()].some(input => input.threadId === threadId);
}

function finishClosingSession(threadId: string): void {
  const closing = closingSessions.get(threadId);
  if (closing?.phase !== "waiting-for-input" || hasPendingRoutedWork(threadId)) return;
  // SDK output is synchronous. Let the current SDK operation finish before forwarding stop.
  queueMicrotask(() => {
    if (closing.phase !== "waiting-for-input" || hasPendingRoutedWork(threadId)) return;
    closing.phase = "final-stop";
    pendingIdentities.set(closing.id, { threadId, stop: true });
    experimental_acpProviderBridge.handleLine(closing.line);
  });
}

function settlePendingInputs(message: any): void {
  if (message.method === undefined) {
    const input = pendingInputs.get(message.id);
    if (input && (!input.steer || message.error)) {
      pendingInputs.delete(message.id);
      finishClosingSession(input.threadId);
    }
    return;
  }
  const threadId = message.params?.threadId;
  const deltas = message.method === "thread/delta" && Array.isArray(message.params?.deltas) ? message.params.deltas : [];
  if (typeof threadId !== "string" || (deltas.length === 0 && message.method !== "error")) return;
  // The SDK acknowledges ordinary steers when queued. Acceptance or turn termination
  // is what establishes that the SDK can no longer rebuild to execute that input.
  const ended = message.method === "error" || deltas.some((delta: any) => delta.kind === "turn.boundary");
  for (const [id, input] of pendingInputs) {
    if (input.threadId !== threadId || !input.steer) continue;
    if (ended || deltas.some((delta: any) => delta.kind === "input.accepted" && delta.clientRequestId === input.clientRequestId)) {
      pendingInputs.delete(id);
    }
  }
  finishClosingSession(threadId);
}

function wrapProfileSessionIds(line: string): string | null {
  let message: any;
  try { message = JSON.parse(line); } catch { return line; }
  if (message?.jsonrpc !== "2.0") return line;
  if (pendingInputs.size > 0) settlePendingInputs(message);

  if (message.method === undefined) {
    const pending = pendingIdentities.get(message.id);
    if (!pending) return line;
    pendingIdentities.delete(message.id);
    const { threadId, profileHash, stop } = pending;
    if (stop) {
      const closing = closingSessions.get(threadId);
      if (closing?.phase === "first-stop" && message.result?.ok === true) {
        if (closing.pastEarlyAck) {
          // The SDK reached a session and dropped its queue before awaiting process exit.
          // Dropped steers have no completion notification.
          for (const [id, input] of pendingInputs) {
            if (input.threadId === threadId && input.steer) pendingInputs.delete(id);
          }
        }
        closing.phase = "waiting-for-input";
        finishClosingSession(threadId);
        return null;
      }
      closingSessions.delete(threadId);
      if (message.result?.ok === true) activeIdentities.delete(threadId);
      return line;
    }
    finishClosingSession(threadId);
    if (message.error) return line;
    const sessionId = message.result?.providerThreadId;
    if (typeof sessionId !== "string" || !sessionId) {
      if (profileHash === undefined) return line;
      return JSON.stringify({ jsonrpc: "2.0", id: message.id, error: profileError(ANTIGRAVITY_INVALID_PROFILE_MESSAGE) });
    }
    activeIdentities.set(threadId, { profileHash, sessionId });
    if (profileHash === undefined) return line;
    message.result.providerThreadId = encodeProfileSessionId(threadId, sessionId, profileHash);
    return JSON.stringify(message);
  }

  const { threadId, providerThreadId } = message.params ?? {};
  if (typeof threadId !== "string" || typeof providerThreadId !== "string") return line;
  const active = activeIdentities.get(threadId);
  const pending = pendingIdentityForThread(threadId);
  if (!active && (!pending || pending.stop)) return null;
  if (message.method === "thread/identity" || message.method === "session/replaced") {
    if (closingSessions.has(threadId) || pending?.stop) return null;
  }
  const profileHash = active?.profileHash ?? pending?.profileHash;
  // BB persists this SDK notification when a process rebuild changes the native session ID.
  if (message.method === "session/replaced" && active) active.sessionId = providerThreadId;
  if (profileHash === undefined) return line;
  message.params.providerThreadId = encodeProfileSessionId(threadId, providerThreadId, profileHash);
  return JSON.stringify(message);
}

function guardProfileSession(request: Record<string, any> | null): string | undefined {
  const params = request?.params;
  const threadId = params?.threadId;
  if (typeof threadId !== "string") return;
  const method = request?.method;
  const id = request?.jsonrpc === "2.0" && (typeof request.id === "string" || typeof request.id === "number")
    ? request.id : undefined;
  if (method === "thread/fork") return "Antigravity does not support forking threads.";
  if ((closingSessions.has(threadId) || pendingIdentityForThread(threadId)?.stop) && method !== "thread/discard") {
    return "Antigravity is stopping this session. Try again when it has stopped.";
  }

  const sessionId = decodeProfileSessionId(params.providerThreadId);
  if (method === "thread/stop" || method === "thread/discard") {
    if (sessionId) params.providerThreadId = sessionId.sessionId;
    // The SDK acknowledges discard without releasing its live session. Wait for stop.
    if (method === "thread/stop" && id !== undefined) pendingIdentities.set(id, { threadId, stop: true });
    return;
  }
  const startsSession = method === "thread/start" || method === "thread/resume";
  if (!startsSession && method !== "turn/start" && method !== "turn/steer") return;

  if (pendingIdentityForThread(threadId)) return "Antigravity is updating this session. Try again when it is ready.";
  const profile = prepareAntigravityProfile(params.options);
  if (sessionId === null || (sessionId && profile == null)) return ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE;
  if (profile === null) return ANTIGRAVITY_INVALID_PROFILE_MESSAGE;
  const profileHash = profile === undefined ? undefined : hashAntigravityProfile(profile);
  const active = activeIdentities.get(threadId);
  if (active && active.profileHash !== profileHash) return ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE;

  if (method === "thread/start") {
    if (active?.profileHash || sessionId !== undefined) return ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE;
  } else if (sessionId) {
    if (profileHash === undefined || !matchesProfileSessionId(threadId, sessionId, profileHash)) {
      return ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE;
    }
    if (active && active.sessionId !== sessionId.sessionId) {
      return "This Antigravity session was replaced. Retry with the current session.";
    }
    params.providerThreadId = sessionId.sessionId;
  } else if (profileHash !== undefined) {
    return ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE;
  }

  if (startsSession) {
    if (id === undefined) return ANTIGRAVITY_INVALID_PROFILE_MESSAGE;
    pendingIdentities.set(id, { threadId, profileHash });
  } else if (!active) {
    return "No active ACP session.";
  }
}

export function rememberApprovalSetting(request: any) {
  if (request?.method === "thread/stop" || request?.method === "thread/discard") {
    const threadId = request?.params?.threadId;
    if (typeof threadId === "string") {
      autoApproveThreads.delete(threadId);
      commandDescriptionsThreads.delete(threadId);
    }
    return;
  }
  const schema = request?.method === "thread/start" ? threadStartParamsSchema
    : request?.method === "thread/resume" ? threadResumeParamsSchema
    : request?.method === "turn/start" ? turnStartParamsSchema : null;
  const parsed = schema?.safeParse(request.params);
  if (parsed?.success) {
    const providerOptions = parsed.data.options.providerOptions;
    if (typeof providerOptions?.commandDescriptionsEnabled === "boolean") {
      commandDescriptionsThreads.set(parsed.data.threadId, providerOptions.commandDescriptionsEnabled);
    }
    autoApproveThreads.set(parsed.data.threadId,
      providerOptions?.autoApprove === true &&
      parsed.data.options.permissionMode === "accept-edits" && parsed.data.options.permissionEscalation === "ask");
  }
}

function applyAntigravityDefaults(line: string, parsed: unknown): { line: string; parsed: unknown } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { line, parsed };
  const record = parsed as Record<string, any>;
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? (record.params as Record<string, any>)
    : null;
  if (!params) return { line, parsed };
  const options = params.options && typeof params.options === "object" && !Array.isArray(params.options)
    ? (params.options as Record<string, any>)
    : null;
  const providerOptions = options?.providerOptions && typeof options.providerOptions === "object" && !Array.isArray(options.providerOptions)
    ? (options.providerOptions as Record<string, any>)
    : null;
  if (typeof params.threadId === "string" && typeof providerOptions?.commandDescriptionsEnabled === "boolean") {
    commandDescriptionsThreads.set(params.threadId, providerOptions.commandDescriptionsEnabled);
  }
  if (providerOptions && (!providerOptions.acpDialect || providerOptions.acpDialect === "acp")) {
    const updated = {
      ...record,
      params: {
        ...params,
        options: {
          ...options,
          providerOptions: {
            ...providerOptions,
            acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
          },
        },
      },
    };
    return { line: JSON.stringify(updated), parsed: updated };
  }
  return { line, parsed };
}

export function interceptApproval(line: string): boolean {
  if (interceptSubagentApproval(line)) return true;
  let message: any;
  try { message = JSON.parse(line); } catch { return false; }
  if (isSubagentApprovalForDisabledThread(message)) return false;
  if (message?.jsonrpc !== "2.0" || message.method !== "interaction/request" ||
      (typeof message.id !== "string" && typeof message.id !== "number") ||
      !autoApproveThreads.get(message.params?.threadId)) return false;
  const payload = message.params?.payload;
  if (payload?.kind !== "approval" || typeof payload.subject?.itemId !== "string" ||
      !["command", "file_change", "tool_use"].includes(payload.subject.kind) ||
      !(payload.reason === null || typeof payload.reason === "string") ||
      !Array.isArray(payload.availableDecisions) ||
      !payload.availableDecisions.every((value: unknown) => ["allow_once", "allow_for_session", "deny"].includes(value as string))) return false;
  const subject = payload.subject;
  if (subject.kind === "command" && (typeof subject.command !== "string" || !Array.isArray(subject.actions) || !(subject.cwd === null || typeof subject.cwd === "string") || subject.sessionGrant !== null)) return false;
  if (subject.kind === "file_change" && (!(subject.writeScope === null || typeof subject.writeScope === "string") || subject.sessionGrant !== null)) return false;
  if (subject.kind === "tool_use" && (typeof subject.tool !== "string" || typeof subject.presentation?.icon?.glyph !== "string" || typeof subject.presentation?.label?.pending !== "string" || typeof subject.presentation?.label?.completed !== "string")) return false;
  const decisions = payload.availableDecisions;
  const decision = decisions.includes("allow_once") ? "allow_once" : decisions.includes("allow_for_session") ? "allow_for_session" : null;
  if (!decision) return false;
  queueMicrotask(() => experimental_acpProviderBridge.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: message.id, result: { decision, grantedPermissions: null },
  })));
  return true;
}
function ensureStdoutFilter() {
  if (stdoutFilterInstalled) return;
  stdoutFilterInstalled = true;
  registerAntigravityAcpDialect();
  const write = process.stdout.write.bind(process.stdout);
  rawStdoutWrite = write;
  const output = modeControlOutput(
    interceptApproval,
    line => {
      const wrapped = wrapProfileSessionIds(line);
      return wrapped === null ? [] : backgroundTaskTracker.processStdoutLine(
        applyThreadCommandDescriptions(wrapped, commandDescriptionsThreads),
      );
    },
    compaction.verify,
  );
  output.on("data", chunk => write(chunk));
  process.stdout.write = ((chunk: any, encodingOrCallback?: any, callback?: any) =>
    output.write(chunk, encodingOrCallback, callback)) as typeof process.stdout.write;
}

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  start() {
    ensureStdoutFilter();
  },
  handleLine(line: string) {
    ensureStdoutFilter();
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    const request = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : null;
    if (request?.method !== "initialize" && !resolveAntigravityLaunchSpec(parsed)) {
      const id = request?.id;
      if (request?.jsonrpc === "2.0" && (typeof id === "string" || typeof id === "number")) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...missingCliResponse(request.method) })}\n`);
      }
      return;
    }

    // A held steer becomes turn/start with the same session reference and execution options.
    const profileRejection = guardProfileSession(request);
    if (profileRejection) {
      const id = request?.id;
      if (request?.jsonrpc === "2.0" && (typeof id === "string" || typeof id === "number")) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: profileError(profileRejection) })}\n`);
      }
      return;
    }

    if (parsed !== null) line = JSON.stringify(parsed);
    const withDefaults = applyAntigravityDefaults(line, parsed);
    // Runs first: a steer into a held turn is rewritten to turn/start, which the transforms below
    // must then treat like any other turn/start.
    const inbound = backgroundTaskTracker.handleInbound(withDefaults.parsed);
    const routed = inbound.request === withDefaults.parsed
      ? withDefaults
      : { line: JSON.stringify(inbound.request), parsed: inbound.request };
    const subagentTransformed = transformSubagentRequest(routed.line, routed.parsed);
    rememberApprovalSetting(subagentTransformed.parsed);
    const closeDeltas = inbound.deltas;
    if (closeDeltas.length > 0) {
      const stopThreadId = (subagentTransformed.parsed as Record<string, any> | null)?.params?.threadId;
      if (typeof stopThreadId === "string") {
        const write = rawStdoutWrite ?? process.stdout.write.bind(process.stdout);
        write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId: stopThreadId, deltas: closeDeltas } })}\n`);
      }
    }
    const usageRequest = parseUsageRequest(subagentTransformed.parsed);
    if (usageRequest !== null) {
      void readAntigravityProviderUsage({
        command: usageRequest.command,
        cwd: usageRequest.cwd,
        env: { ...process.env, ...usageRequest.env },
      }).then(result => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: usageRequest.id, result })}\n`);
      }).catch(error => {
        const result = {
          supported: true,
          usage: {
            status: "error",
            message: error instanceof Error ? error.message : "Antigravity CLI usage could not be collected.",
            planLabel: null,
            accountEmail: null,
          },
        };
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: usageRequest.id, result })}\n`);
      });
      return;
    }
    const forwarded = subagentTransformed.parsed as Record<string, any> | null;
    const usesRoutedProfile = activeIdentities.get(forwarded?.params?.threadId)?.profileHash !== undefined;
    const compactError = compaction.prepare(forwarded, usesRoutedProfile);
    if (compactError) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request?.id, error: { code: -32000, message: compactError } })}\n`);
      return;
    }
    if ((forwarded?.method === "turn/start" || forwarded?.method === "turn/steer") &&
        forwarded.jsonrpc === "2.0" && (typeof forwarded.id === "string" || typeof forwarded.id === "number") &&
        typeof forwarded.params?.threadId === "string" && typeof forwarded.params?.clientRequestId === "string" && usesRoutedProfile) {
      pendingInputs.set(forwarded.id, {
        threadId: forwarded.params.threadId,
        clientRequestId: forwarded.params.clientRequestId,
        steer: forwarded.method === "turn/steer",
      });
    }
    const forwardedLine = mapPromptMode(subagentTransformed.line, subagentTransformed.parsed);
    const threadId = forwarded?.params?.threadId;
    if (forwarded?.method === "thread/stop" && typeof threadId === "string" &&
        (typeof forwarded.id === "string" || typeof forwarded.id === "number") && hasPendingRoutedWork(threadId)) {
      const closing: ClosingSession = { id: forwarded.id, line: forwardedLine, pastEarlyAck: false, phase: "first-stop" };
      closingSessions.set(threadId, closing);
      // In SDK 0.6.178, stop with no session replies inline. An already stopping session
      // replies after one await. A stop that takes ownership awaits connection.kill first.
      // Keep the early acknowledgement fenced until the original input/setup settles.
      experimental_acpProviderBridge.handleLine(forwardedLine);
      queueMicrotask(() => { closing.pastEarlyAck = true; });
      return;
    }
    experimental_acpProviderBridge.handleLine(forwardedLine);
  },
};
