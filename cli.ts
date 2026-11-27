import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { experimental_hostToolchain } from "@get-bb/plugin-sdk/process";
import { experimental_buildProviderCliEnv, experimental_compareVersions, experimental_versionFrom, type ProviderHealthResult } from "@get-bb/plugin-sdk/provider-bridge";

const BB_ANTIGRAVITY_GEMINI_DIR_ENV = "BB_ANTIGRAVITY_GEMINI_DIR";
const BB_ANTIGRAVITY_APP_DATA_DIR_ENV = "BB_ANTIGRAVITY_APP_DATA_DIR";
const DEFAULT_ANTIGRAVITY_GEMINI_DIR = ".gemini";
const DEFAULT_ANTIGRAVITY_APP_DATA_DIR = "antigravity-cli";

const GEMINI_DIR_FLAGS = ["--gemini-dir", "--gemini_dir"] as const;
const APP_DATA_DIR_FLAGS = ["--app-data-dir", "--app_data_dir"] as const;

function isFullyQualified(path: string | undefined): path is string {
  // Windows considers paths rooted on the current drive absolute as well.
  return path !== undefined && isAbsolute(path) && (process.platform !== "win32" || parse(path).root.length > 1);
}

function windowsEnvKey(env: NodeJS.ProcessEnv, name: string): string {
  // Node uses the first case-insensitive match in sorted key order on Windows.
  return Object.keys(env).sort().find(key => key.toUpperCase() === name) ?? name;
}

export function hostHomeDirectory(): string | undefined {
  try {
    const home = homedir();
    return isFullyQualified(home) ? home : undefined;
  } catch {
    return undefined;
  }
}

function installerPath(env: NodeJS.ProcessEnv): string | null {
  const windows = process.platform === "win32";
  if (windows) {
    const localAppData = env[windowsEnvKey(env, "LOCALAPPDATA")];
    if (isFullyQualified(localAppData)) return join(localAppData, "agy", "bin", "agy.exe");
  }
  const home = hostHomeDirectory();
  if (home === undefined) return null;
  return windows ? join(home, "AppData", "Local", "agy", "bin", "agy.exe") : join(home, ".local", "bin", "agy");
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
  const homeKey = process.platform === "win32" ? windowsEnvKey(env, "USERPROFILE") : "HOME";
  if (!isFullyQualified(env[homeKey])) {
    // An empty value prevents the SDK from rediscovering home or expanding a bare drive.
    const home = env[homeKey] === undefined ? hostHomeDirectory() : undefined;
    env = { ...env, [homeKey]: home ?? "" };
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

function readDirectoryFlag(args: string[], names: readonly string[]): { value: string; index: number; length: number } | undefined {
  let found;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--") break;
    const flag = names.find(name => args[i] === name || args[i].startsWith(`${name}=`));
    if (flag === undefined) continue;
    if (found) throw new Error("Duplicate profile flag");
    const length = args[i] === flag ? 2 : 1;
    const value = length === 2 ? args[i + 1] : args[i].slice(flag.length + 1);
    if (!value || value.startsWith("--") || value.includes("\0")) throw new Error("Invalid profile flag");
    found = { value, index: i, length };
    i += length - 1;
  }
  return found;
}

function realDirectoryPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path === parent || !isDirectoryOrMissing(path)) throw error;
    return join(realDirectoryPath(parent), basename(path));
  }
}

function isDirectoryOrMissing(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

// undefined is the default profile; null means the requested profile cannot be bound safely.
export function prepareAntigravityProfile(options: Record<string, any> | undefined): string[] | null | undefined {
  const providerOptions = options?.providerOptions;
  const spec = providerOptions?.acpLaunchSpec;
  if (!Array.isArray(spec?.args) || spec.args[0] !== "acp") return undefined;
  try {
    const args: string[] = spec.args;
    const geminiFlag = readDirectoryFlag(args, GEMINI_DIR_FLAGS);
    const appDataFlag = readDirectoryFlag(args, APP_DATA_DIR_FLAGS);
    if (providerOptions.profileRoutingEnabled !== true) {
      return geminiFlag === undefined && appDataFlag === undefined ? undefined : null;
    }
    const env = experimental_buildProviderCliEnv({ ...spec.env, ...options?.envVars });
    const gemini = geminiFlag?.value ?? env[BB_ANTIGRAVITY_GEMINI_DIR_ENV]?.trim() ?? "";
    const appData = appDataFlag?.value ?? env[BB_ANTIGRAVITY_APP_DATA_DIR_ENV]?.trim() ?? "";
    if (!gemini && !appData) return undefined;
    if (gemini.includes("\0") || appData.includes("\0") || args.includes("--")) return null;

    const homeKey = process.platform === "win32" ? windowsEnvKey(env, "USERPROFILE") : "HOME";
    const home = env[homeKey];
    const geminiValue = gemini || DEFAULT_ANTIGRAVITY_GEMINI_DIR;
    if (!isFullyQualified(geminiValue) && (isAbsolute(geminiValue) || parse(geminiValue).root || !isFullyQualified(home))) return null;
    const geminiDir = realDirectoryPath(resolve(home ?? "", geminiValue));
    const appDataValue = appData || DEFAULT_ANTIGRAVITY_APP_DATA_DIR;
    if (!/^[a-z0-9_][a-z0-9_.-]*$/i.test(appDataValue) || appDataValue.endsWith(".")) return null;
    const appDataDir = join(geminiDir, appDataValue);
    // ACP accepts an app-data name under Gemini. Reject links that can redirect that name.
    if (!isDirectoryOrMissing(appDataDir)) return null;
    // The shared bridge keeps the original launch arguments in any replacement process.
    // Pin Gemini to its resolved path so a changed alias cannot redirect a replacement.
    args.splice(geminiFlag?.index ?? args.length, geminiFlag?.length ?? 0, "--gemini-dir", geminiDir);
    if (appDataFlag === undefined && appData) args.push("--app-data-dir", appDataValue);
    return [geminiDir, appDataValue];
  } catch {
    return null;
  }
}

// Resolve on the agent host, where the CLI is installed, rather than the BB server.
export function resolveAntigravityLaunchSpec(request: any): boolean {
  const params = request?.params;
  const targets = [
    params?.providerOptions,
    params?.options?.providerOptions,
  ];
  for (const options of targets) {
    const spec = options?.acpLaunchSpec;
    if (!spec || typeof spec !== "object") continue;
    const env = experimental_buildProviderCliEnv(spec.env);
    if (spec.command === "agy") {
      // An unresolved bare command would let the ACP bridge retry in the workspace and session PATH.
      const command = resolveAntigravityCommand("agy", { env }) ?? installerPath(env);
      if (command === null) return false;
      spec.command = command;
    }
  }
  return true;
}
