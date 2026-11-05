import { experimental_acpLaunchSpecSchema, experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { modeControlOutput } from "./mode-controls.ts";
import { mapPromptMode } from "./prompt-mode.ts";
import { readAntigravityProviderUsage } from "./usage.ts";

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

let stdoutFilterInstalled = false;
function ensureStdoutFilter() {
  if (stdoutFilterInstalled) return;
  stdoutFilterInstalled = true;
  const write = process.stdout.write.bind(process.stdout);
  const output = modeControlOutput();
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
    const usageRequest = parseUsageRequest(parsed);
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
    experimental_acpProviderBridge.handleLine(mapPromptMode(line, parsed));
  },
};
