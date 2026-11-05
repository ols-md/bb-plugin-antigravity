import { experimental_acpLaunchSpecSchema, experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { modeControlOutput } from "./mode-controls.ts";
import { mapPromptMode } from "./prompt-mode.ts";
import { readAntigravityProviderUsage } from "./usage.ts";

function parseUsageRequest(line: string): { id: string | number; command: string; cwd?: string; env?: Record<string, string> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
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

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  start() {
    const write = process.stdout.write.bind(process.stdout);
    const output = modeControlOutput();
    output.on("data", chunk => write(chunk));
    process.stdout.write = output.write.bind(output) as typeof process.stdout.write;
  },
  handleLine(line: string) {
    const usageRequest = parseUsageRequest(line);
    if (usageRequest !== null) {
      void readAntigravityProviderUsage({
        command: usageRequest.command,
        cwd: usageRequest.cwd,
        env: { ...process.env, ...usageRequest.env },
      }).then(result => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: usageRequest.id, result })}\n`);
      });
      return;
    }
    experimental_acpProviderBridge.handleLine(mapPromptMode(line));
  },
};
