import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, parse } from "node:path";
import { experimental_hostToolchain } from "@get-bb/plugin-sdk/process";
import { experimental_buildProviderCliEnv, experimental_compareVersions, experimental_versionFrom, type ProviderHealthResult } from "@get-bb/plugin-sdk/provider-bridge";

function isFullyQualified(path: string | undefined): path is string {
  // Windows considers paths rooted on the current drive absolute as well.
  return path !== undefined && isAbsolute(path) && (process.platform !== "win32" || parse(path).root.length > 1);
}

function windowsEnvKey(env: NodeJS.ProcessEnv, name: string): string {
  return Object.keys(env).find(key => key.toUpperCase() === name) ?? name;
}

function installerPath(env: NodeJS.ProcessEnv): string | null {
  const home = homedir();
  if (process.platform !== "win32") return isFullyQualified(home) ? join(home, ".local", "bin", "agy") : null;
  const localAppData = env[windowsEnvKey(env, "LOCALAPPDATA")];
  const root = isFullyQualified(localAppData) ? localAppData
    : isFullyQualified(home) ? join(home, "AppData", "Local") : null;
  return root === null ? null : join(root, "agy", "bin", "agy.exe");
}

const MIN_AGY_ACP_VERSION = "1.5.0";

export function addAntigravityHealthDiagnostic(result: ProviderHealthResult | undefined): void {
  if (result?.supported !== true || result.health?.status !== "ready") return;
  const health = result.health;
  const version = health.installedVersion;
  if (typeof version !== "string" || experimental_versionFrom(version) !== version ||
      experimental_compareVersions(version, MIN_AGY_ACP_VERSION) >= 0) return;

  health.status = "unsupported_version";
  health.minimumSupportedVersion = MIN_AGY_ACP_VERSION;
  health.statusMessage = `Antigravity CLI ${version} is installed on the agent host. BB needs version ${MIN_AGY_ACP_VERSION} or later for ACP. Run \`agy update\` on that host, then check provider health again.`;
}

export function resolveAntigravityCommand(command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string | null {
  if (command !== "agy") return experimental_hostToolchain.resolve(command, options);
  let env = options?.env ?? process.env;
  if (process.platform === "win32") {
    const profileKey = windowsEnvKey(env, "USERPROFILE");
    // The SDK joins home-based PATH entries, which can turn a bare drive into a drive root.
    if (!isFullyQualified(env[profileKey] ?? homedir())) env = { ...env, [profileKey]: "" };
  }
  const hostPath = experimental_hostToolchain.environment(env).PATH ?? "";
  // Windows bare-name lookup starts in cwd. Search the host PATH explicitly.
  for (const entry of hostPath.split(delimiter)) {
    const directory = process.platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!isFullyQualified(directory)) continue;
    const found = experimental_hostToolchain.resolve(join(directory, command), { env });
    if (found) return found;
  }
  const candidate = installerPath(env);
  if (candidate === null) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

// Resolve on the agent host, where the CLI is installed, rather than the BB server.
export function resolveAntigravityLaunchSpec(request: any): boolean {
  const params = request?.params;
  for (const options of [params?.providerOptions, params?.options?.providerOptions]) {
    const spec = options?.acpLaunchSpec;
    if (spec?.command !== "agy") continue;
    const env = experimental_buildProviderCliEnv(spec.env);
    // An unresolved bare command would let the ACP bridge retry in the workspace and session PATH.
    const command = resolveAntigravityCommand("agy", { env }) ?? installerPath(env);
    if (command === null) return false;
    spec.command = command;
  }
  return true;
}
