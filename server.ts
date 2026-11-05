import type { BbPluginApi } from "@get-bb/plugin-sdk";

const launchSpec = {
  displayName: "Antigravity CLI",
  command: "agy",
  args: ["acp", "--disable-telemetry"],
  env: {},
};

export default async function antigravity(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sandbox: {
      type: "boolean",
      label: "Request CLI terminal sandbox",
      description: "Add --sandbox for new threads. Otherwise use CLI settings. Requires a supported OS; the CLI may fall back to approval prompts. Full access can approve requests outside the sandbox.",
      default: false,
    },
    enabled: {
      type: "boolean",
      label: "Enable Antigravity CLI",
      description: "Show Antigravity in the provider picker. Existing running turns are not stopped.",
      default: true,
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
      acpDialect: "acp",
    },
    deriveProviderOptions({ settings }) {
      return {
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
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high"],
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

