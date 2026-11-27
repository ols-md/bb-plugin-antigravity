import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ANTIGRAVITY_ACP_DIALECT_ID } from "./dialect.ts";
import { registerAntigravityUsageSource } from "./usage.ts";

const launchSpec = {
  displayName: "Antigravity CLI",
  command: "agy",
  args: ["acp", "--disable-telemetry"],
  env: {},
};

export default async function antigravity(bb: BbPluginApi) {
  registerAntigravityUsageSource(bb);
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Show in provider picker",
      description: "Active turns continue when you hide the provider.",
      default: true,
    },
    autoApprove: {
      type: "boolean",
      label: "Automatically approve ACP permission requests",
      description: "In Accept edits, approve requests on new turns, including commands outside the sandbox.",
      default: false,
    },
    sandbox: {
      type: "boolean",
      label: "Request CLI terminal sandbox",
      description: "Request sandboxing for new threads on supported hosts. Off inherits CLI settings. Full access can approve commands outside the sandbox.",
      default: false,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description: "Prevent Antigravity CLI from using its native subagent tools so agents use bb for delegation.",
      default: false,
    },
    commandDescriptionsEnabled: {
      type: "boolean",
      label: "Show command descriptions",
      description: "Display Antigravity tool summaries on command execution cards.",
      default: true,
    },
    profileRoutingEnabled: {
      type: "boolean",
      label: "Enable Antigravity profile routing",
      description: "Use Antigravity profile overrides for sessions. Turning this off pauses routed sessions.",
      default: false,
    },
  });
  const register = () => bb.providers.register({
    id: "antigravity-cli",
    displayName: "Antigravity CLI",
    icon: "./assets/provider.svg",
    family: "antigravity",
    strings: {
      signInHint: "Run `agy acp --login` on this machine, then retry.",
      expiredHint: "Run `agy acp --login` on this machine to refresh your sign-in.",
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    },
    experimental_bridgeOptions: {
      acpLaunchSpec: launchSpec,
      acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
    },
    deriveProviderOptions({ settings }) {
      return {
        autoApprove: settings.autoApprove === true,
        providerSubagentsEnabled: settings.subagentsDisabled !== true,
        commandDescriptionsEnabled: settings.commandDescriptionsEnabled !== false,
        profileRoutingEnabled: settings.profileRoutingEnabled === true,
        acpDialect: ANTIGRAVITY_ACP_DIALECT_ID,
        acpLaunchSpec: {
          ...launchSpec,
          args: [...launchSpec.args, ...(settings.sandbox === true ? ["--sandbox"] : [])],
        },
      };
    },
    experimental_nativeSkillRoots: {
      user: [".gemini/antigravity-cli/skills", ".gemini/skills", ".gemini/config/skills"],
      project: [".agents/skills", ".agent/skills"],
    },
    experimental_visibility: "always",
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    models: { fallback: [], scope: "workspace" },
  });
  let registration = (await settings.get()).enabled ? register() : undefined;
  settings.onChange(({ enabled }) => {
    if (Boolean(registration) === enabled) return;
    registration?.dispose();
    registration = enabled ? register() : undefined;
  });
}

