import { experimental_execHostFile } from "@get-bb/plugin-sdk/process";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resolveAntigravityCommand } from "./cli.ts";

const USAGE_TIMEOUT_MS = 15_000;
const USAGE_CACHE_TTL_MS = 60_000;
const PROVIDER_ID = "antigravity-cli";
const PLUGIN_ID = "antigravity-cli";

const agyBucketSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  window: z.string().optional(),
  remaining_fraction: z.number().optional(),
  remaining_amount: z.number().optional(),
  disabled: z.boolean().optional(),
  reset_time: z.string().nullable().optional(),
}).passthrough();

const agyGroupSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  buckets: z.array(agyBucketSchema).default([]),
}).passthrough();

const agyUsageCommandSchema = z.object({
  status: z.string().optional(),
  error: z.unknown().optional(),
  command: z.object({
    name: z.literal("usage"),
    data: z.object({
      description: z.string().optional(),
      groups: z.array(agyGroupSchema).default([]),
      buckets: z.array(agyBucketSchema).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

type AgyBucket = z.infer<typeof agyBucketSchema>;
type AgyGroup = z.infer<typeof agyGroupSchema>;

function clampUsedPercent(remainingFraction: number): number {
  if (!Number.isFinite(remainingFraction)) return 0;
  const used = (1 - remainingFraction) * 100;
  return Math.min(100, Math.max(0, Math.round(used)));
}

function normalizeResetIso(resetTime: string | null | undefined): string | null {
  if (!resetTime) return null;
  const parsed = new Date(resetTime);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function collapseWhitespace(text: string): string {
  return text.trim().split(/\s+/u).join(" ");
}

function stripTrailingToken(text: string, tokenLower: string): string {
  const suffix = ` ${tokenLower}`;
  if (text.toLowerCase().endsWith(suffix)) {
    return text.slice(0, -suffix.length);
  }
  return text;
}

function shortenGroupName(groupName: string): string {
  const normalized = collapseWhitespace(groupName);
  const lower = normalized.toLowerCase();
  if (lower === "gemini models") return "Gemini";
  if (lower === "claude and gpt models") return "Claude/GPT";
  if (lower === "gemini 4 argon") return "Argon";
  return stripTrailingToken(normalized, "models");
}

function formatWindowSuffix(bucket: AgyBucket): string {
  const win = bucket.window?.trim().toLowerCase();
  const normalizedName = collapseWhitespace(bucket.name);
  const lowerName = normalizedName.toLowerCase();
  if (win === "5h" || win === "five-hour" || lowerName.startsWith("five hour")) return "5h";
  if (win === "weekly" || lowerName.includes("weekly")) return "7d";
  if (win === "daily" || lowerName.includes("daily")) return "1d";
  if (win) return win;
  const withoutRemaining = stripTrailingToken(normalizedName, "remaining");
  const withoutLimit = stripTrailingToken(withoutRemaining, "limit");
  return withoutLimit.toLowerCase() === "limit" ? "" : withoutLimit;
}

export function formatBucketWindowLabel(groupName: string | null, bucket: AgyBucket): string {
  const suffix = formatWindowSuffix(bucket);
  if (!groupName) return suffix || bucket.name;
  const shortGroup = shortenGroupName(groupName);
  if (!suffix || shortGroup.toLowerCase() === suffix.toLowerCase()) return shortGroup;
  return `${shortGroup} ${suffix}`;
}

export function normalizeAntigravityUsageOutput(stdout: string): ProviderUsageResult {
  const trimmed = stdout.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    if (isUnauthenticatedFailure(trimmed)) return { supported: true, usage: { status: "unauthenticated" } };
    if (isExpiredFailure(trimmed)) return { supported: true, usage: { status: "expired" } };
    return {
      supported: true,
      usage: {
        status: "error",
        message: "Antigravity CLI returned malformed usage JSON.",
        planLabel: null,
        accountEmail: null,
      },
    };
  }

  const parsed = agyUsageCommandSchema.safeParse(raw);
  if (!parsed.success) {
    if (isUnauthenticatedFailure(trimmed)) return { supported: true, usage: { status: "unauthenticated" } };
    if (isExpiredFailure(trimmed)) return { supported: true, usage: { status: "expired" } };
    return {
      supported: true,
      usage: {
        status: "error",
        message: "Antigravity CLI usage response was malformed.",
        planLabel: null,
        accountEmail: null,
      },
    };
  }

  const windows: Array<{
    label: string;
    usedPercent: number;
    resetsAt: string | null;
    kind: "custom";
    model: null;
  }> = [];

  const appendBucket = (groupName: string | null, bucket: AgyBucket) => {
    if (bucket.disabled === true) return;
    if (bucket.remaining_fraction === undefined && bucket.remaining_amount !== undefined) return;
    const remainingFraction = bucket.remaining_fraction ?? 0;
    windows.push({
      label: formatBucketWindowLabel(groupName, bucket),
      usedPercent: clampUsedPercent(remainingFraction),
      resetsAt: normalizeResetIso(bucket.reset_time),
      kind: "custom",
      model: null,
    });
  };

  const data = parsed.data.command.data;
  if (data.groups.length > 0) {
    for (const group of data.groups as AgyGroup[]) {
      for (const bucket of group.buckets) {
        appendBucket(group.name, bucket);
      }
    }
  } else if (Array.isArray(data.buckets)) {
    for (const bucket of data.buckets) {
      appendBucket(null, bucket);
    }
  }

  return {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows,
    },
  };
}

function isUnauthenticatedFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("not signed in") ||
    lower.includes("authentication required") ||
    lower.includes("login") && lower.includes("required") ||
    lower.includes("unauthenticated")
  );
}

function isExpiredFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("token expired") ||
    lower.includes("session expired") ||
    lower.includes("invalid_grant") ||
    lower.includes("reauthenticate")
  );
}

export async function readAntigravityProviderUsage(options?: {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: typeof experimental_execHostFile;
  resolveCommand?: (command: string, opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string | null;
}): Promise<ProviderUsageResult> {
  const command = options?.command ?? "agy";
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const resolveCommand = options?.resolveCommand ?? resolveAntigravityCommand;
  const execFile = options?.execFile ?? experimental_execHostFile;

  try {
    const resolvedCommand = command ? await resolveCommand(command, { cwd, env }) : null;
    if (!resolvedCommand) {
      return { supported: true, usage: { status: "not_installed" } };
    }
    const { stdout, stderr } = await execFile(
      resolvedCommand,
      ["-p", "/usage", "--output-format", "json"],
      {
        cwd,
        env,
        timeout: USAGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    const combined = `${stdout}\n${stderr}`;
    const normalized = normalizeAntigravityUsageOutput(stdout);
    const usage = normalized.usage as { status: string };
    if (usage.status === "error" && isUnauthenticatedFailure(combined)) {
      return { supported: true, usage: { status: "unauthenticated" } };
    }
    if (usage.status === "error" && isExpiredFailure(combined)) {
      return { supported: true, usage: { status: "expired" } };
    }
    return normalized;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { supported: true, usage: { status: "not_installed" } };
    }
    const stdout = error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const message = error instanceof Error ? error.message : String(error);
    const combined = `${message}\n${stdout}\n${stderr}`;
    if (isUnauthenticatedFailure(combined)) {
      return { supported: true, usage: { status: "unauthenticated" } };
    }
    if (isExpiredFailure(combined)) {
      return { supported: true, usage: { status: "expired" } };
    }
    return {
      supported: true,
      usage: {
        status: "error",
        message: "Antigravity CLI usage could not be collected.",
        planLabel: null,
        accountEmail: null,
      },
    };
  }
}

const baseUsageFields = {
  plan: z.object({ id: z.string().min(1), multiplier: z.number().int().positive().nullable() }).nullable().default(null),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

const windowKindSchema = z.enum(["five-hour", "daily", "weekly", "custom"]);

const usageResourceWindowSchema = z.object({
  kind: windowKindSchema.default("custom"),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.object({
    usedUsdCents: z.number().nonnegative(),
    limitUsdCents: z.number().positive(),
  }).nullable(),
});

const usageStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), ...baseUsageFields, windows: z.array(usageResourceWindowSchema) }),
  z.object({ status: z.literal("not_installed"), ...baseUsageFields }),
  z.object({ status: z.literal("unauthenticated"), ...baseUsageFields }),
  z.object({ status: z.literal("expired"), ...baseUsageFields }),
  z.object({ status: z.literal("error"), ...baseUsageFields, message: z.string() }),
]);

const accountKeySchema = z.string().min(1).nullable().default(null);

const usageResourceSchema = z.object({
  accountKey: accountKeySchema,
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
  ]),
});

const listResourcesOutputSchema = z.object({
  label: z.string().min(1).optional(),
  resources: z.array(usageResourceSchema),
});

const getResourceOutputSchema = z.object({
  accountKey: accountKeySchema,
  observedAt: z.number().int().nonnegative().nullable(),
  usage: usageStateSchema,
});

const LIST_RESOURCES_METHOD = "provider-usage.v1.listResources";
const GET_RESOURCE_METHOD = "provider-usage.v1.getResource";

const providerUsageSourceContract = defineRpcContract({
  [LIST_RESOURCES_METHOD]: {
    input: z.object({}),
    output: listResourcesOutputSchema,
    experimental_description: "Host-local usage inventory owned by the antigravity-cli provider plugin.",
  },
  [GET_RESOURCE_METHOD]: {
    input: z.object({
      resourceId: z.string().min(1),
      refresh: z.boolean(),
    }),
    output: getResourceOutputSchema,
    experimental_description: "Returns actual usage for one listed antigravity-cli host resource.",
  },
});

const DEFAULT_PROVIDER_LABEL = "Antigravity CLI";
const resourceIdTupleSchema = z.tuple([z.string().min(1), z.string().min(1)]);

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 404;
}

function resourceHostId(resourceId: string): string | null {
  try {
    const parsed = resourceIdTupleSchema.safeParse(JSON.parse(resourceId));
    return parsed.success ? parsed.data[0] : null;
  } catch {
    return null;
  }
}

export function registerAntigravityUsageSource(bb: BbPluginApi) {
  if (!bb.rpc || !bb.sdk) return;

  type UsageResource = z.infer<typeof usageResourceSchema>;
  type CachedObservation = z.infer<typeof getResourceOutputSchema>;
  const expectedPluginId = bb.pluginId ?? PLUGIN_ID;
  const cache = new Map<string, CachedObservation>();
  const knownResources = new Map<string, UsageResource>();
  const inflight = new Map<string, { refresh: boolean; promise: Promise<CachedObservation> }>();
  let mutationSeq = 0;
  const confirmedAt = new Map<string, number>();
  const evictedAt = new Map<string, number>();
  let latestHostSnapshot: { seq: number; hostIds: Set<string> } | null = null;

  const isOwnedUsageProvider = (provider: { id: string; pluginId?: string | null }) =>
    provider.id === PROVIDER_ID && provider.pluginId === expectedPluginId;

  const toResourceId = (hostId: string) => JSON.stringify([hostId, PROVIDER_ID]);

  const confirmResource = (resource: UsageResource, seq = ++mutationSeq): boolean => {
    if (seq < (evictedAt.get(resource.id) ?? 0)) return false;
    knownResources.set(resource.id, resource);
    confirmedAt.set(resource.id, Math.max(confirmedAt.get(resource.id) ?? 0, seq));
    return true;
  };

  const evictResource = (resourceId: string, seq = ++mutationSeq) => {
    if (seq < (confirmedAt.get(resourceId) ?? 0)) return;
    cache.delete(resourceId);
    knownResources.delete(resourceId);
    evictedAt.set(resourceId, Math.max(evictedAt.get(resourceId) ?? 0, seq));
  };

  const evictHost = (hostId: string, seq = ++mutationSeq) => {
    for (const id of new Set([...cache.keys(), ...knownResources.keys(), toResourceId(hostId)])) {
      if (resourceHostId(id) === hostId) evictResource(id, seq);
    }
  };

  const toUsageResource = (host: { id: string; name: string }, label?: string): UsageResource => {
    const id = toResourceId(host.id);
    const remembered = knownResources.get(id);
    return {
      id,
      accountKey: cache.get(id)?.accountKey ?? remembered?.accountKey ?? null,
      providerId: PROVIDER_ID,
      label: label || remembered?.label || DEFAULT_PROVIDER_LABEL,
      scope: {
        kind: "host",
        hostId: host.id,
        hostName: host.name,
      },
    };
  };

  const loadResource = async (resourceId: string, refresh: boolean): Promise<CachedObservation> => {
    const [hostId, providerId] = resourceIdTupleSchema.parse(JSON.parse(resourceId));
    if (providerId !== PROVIDER_ID) {
      evictResource(resourceId);
      throw new Error("Usage resource no longer exists.");
    }
    const previous = cache.get(resourceId);
    const unavailable = (message: string): CachedObservation =>
      getResourceOutputSchema.parse({
        accountKey: previous?.accountKey ?? null,
        observedAt: previous?.observedAt ?? null,
        usage: {
          status: "error",
          accountEmail: null,
          planLabel: null,
          message,
        },
      });

    const isEvictedSince = (hostSeq: number, providerSeq: number) =>
      (evictedAt.get(resourceId) ?? 0) > providerSeq ||
      (latestHostSnapshot !== null && latestHostSnapshot.seq > hostSeq && !latestHostSnapshot.hostIds.has(hostId));

    const hostCheckSeq = ++mutationSeq;
    let host: Awaited<ReturnType<typeof bb.sdk.hosts.get>>;
    try {
      host = await bb.sdk.hosts.get({ hostId });
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        evictHost(hostId, hostCheckSeq);
        throw new Error("Usage resource no longer exists.");
      }
      return unavailable("Usage could not be collected from this machine.");
    }

    if (host.status === "disconnected") {
      return unavailable("Machine is disconnected.");
    }

    const providerCheckSeq = ++mutationSeq;
    let providers: Awaited<ReturnType<typeof bb.sdk.providers.list>>;
    try {
      providers = await bb.sdk.providers.list({ hostId, capability: "usage" });
    } catch {
      return unavailable("Usage inventory could not be loaded from this machine.");
    }

    const matchedProvider = providers.find(isOwnedUsageProvider);
    if (!matchedProvider) {
      evictResource(resourceId, providerCheckSeq);
      throw new Error("Usage resource no longer exists.");
    }
    if (
      isEvictedSince(hostCheckSeq, providerCheckSeq) ||
      !confirmResource(toUsageResource(host, matchedProvider.displayName), providerCheckSeq)
    ) {
      throw new Error("Usage resource no longer exists.");
    }

    if (
      !refresh &&
      previous?.usage.status === "ok" &&
      previous.observedAt !== null &&
      Date.now() - previous.observedAt < USAGE_CACHE_TTL_MS
    ) {
      return previous;
    }

    let result: CachedObservation;
    let rawStatus: string;
    try {
      const limits = await bb.sdk.system.usageLimits({ hostId, providerId, refresh });
      const rawUsage = limits[providerId];
      if (!rawUsage) {
        throw new Error("Provider returned no usage information.");
      }
      rawStatus = rawUsage.status;
      const rawRecord = rawUsage as Record<string, unknown>;
      result = getResourceOutputSchema.parse({
        accountKey: previous?.accountKey ?? null,
        observedAt: rawUsage.status === "ok" ? Date.now() : previous?.observedAt ?? null,
        usage: {
          ...rawUsage,
          accountEmail: typeof rawRecord.accountEmail === "string" ? rawRecord.accountEmail : null,
          planLabel: typeof rawRecord.planLabel === "string" ? rawRecord.planLabel : null,
          plan: null,
          ...(rawUsage.status === "ok"
            ? {
                windows: rawUsage.windows.map((win, index) => ({
                  ...win,
                  id: `${index}:${win.label}`,
                  cost: win.cost ?? null,
                })),
              }
            : {}),
        },
      });
    } catch {
      if (isEvictedSince(hostCheckSeq, providerCheckSeq)) {
        throw new Error("Usage resource no longer exists.");
      }
      return unavailable("Usage could not be collected from this machine.");
    }

    if (isEvictedSince(hostCheckSeq, providerCheckSeq)) {
      throw new Error("Usage resource no longer exists.");
    }
    if (rawStatus !== "error" || previous?.usage.status !== "ok") {
      cache.set(resourceId, result);
    }
    return result;
  };

  const collectResource = async (resourceId: string, refresh: boolean): Promise<CachedObservation> => {
    const existing = inflight.get(resourceId);
    if (existing) {
      if (!refresh || existing.refresh) return existing.promise;
      await existing.promise.catch(() => {});
      return collectResource(resourceId, refresh);
    }
    const promise = loadResource(resourceId, refresh).finally(() => {
      inflight.delete(resourceId);
    });
    inflight.set(resourceId, { refresh, promise });
    return promise;
  };

  bb.rpc.register(
    providerUsageSourceContract,
    {
      async [LIST_RESOURCES_METHOD]() {
        const snapshotSeq = ++mutationSeq;
        const hosts = await bb.sdk.hosts.list();
        const connectedHosts = hosts.filter(host => host.status !== "disconnected");
        const settled = await Promise.allSettled(
          connectedHosts.map(host => bb.sdk.providers.list({ hostId: host.id, capability: "usage" })),
        );
        const outcomesByHostId = new Map(
          connectedHosts.map((host, index) => [host.id, settled[index]] as const),
        );

        const resources: UsageResource[] = [];
        const liveHostIds = new Set(hosts.map(host => host.id));
        const confirmedHostIds = new Set<string>();
        const confirmedResourceIds = new Set<string>();

        for (const host of hosts) {
          if (host.status === "disconnected") {
            if (knownResources.has(toResourceId(host.id))) {
              resources.push(toUsageResource(host));
            }
            continue;
          }
          const outcome = outcomesByHostId.get(host.id)!;
          if (outcome.status === "fulfilled") {
            confirmedHostIds.add(host.id);
            for (const provider of outcome.value.filter(isOwnedUsageProvider)) {
              const resource = toUsageResource(host, provider.displayName);
              if (confirmResource(resource, snapshotSeq)) {
                confirmedResourceIds.add(resource.id);
                resources.push(resource);
              }
            }
          } else if (knownResources.has(toResourceId(host.id))) {
            // Preserve previously confirmed host visibility without inventing resources for unconfirmed hosts.
            resources.push(toUsageResource(host));
          }
        }

        if (!latestHostSnapshot || snapshotSeq > latestHostSnapshot.seq) {
          latestHostSnapshot = { seq: snapshotSeq, hostIds: liveHostIds };
        }

        for (const hostId of confirmedHostIds) {
          const expectedId = toResourceId(hostId);
          if (!confirmedResourceIds.has(expectedId)) {
            evictResource(expectedId, snapshotSeq);
          }
        }

        for (const cachedId of new Set([...cache.keys(), ...knownResources.keys()])) {
          const hostId = resourceHostId(cachedId);
          if (!hostId || !liveHostIds.has(hostId)) {
            evictResource(cachedId, snapshotSeq);
          } else if (confirmedHostIds.has(hostId) && !confirmedResourceIds.has(cachedId)) {
            evictResource(cachedId, snapshotSeq);
          }
        }

        return { resources };
      },
      [GET_RESOURCE_METHOD]: ({ resourceId, refresh }) => collectResource(resourceId, refresh),
    },
    {
      experimental_discoverable: true,
      experimental_description: "Host-local usage owned by the antigravity-cli provider plugin. Inventory reads metadata only. Independent of display plugins.",
    },
  );
}
