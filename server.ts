import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function antigravity(bb: BbPluginApi) {
  bb.providers.register({
    id: "antigravity",
    displayName: "Antigravity",
    icon: "Orbit",
    family: "antigravity",
    strings: {
      signInHint: "Run `agy acp --login` on this machine, then retry.",
      expiredHint: "Run `agy acp --login` on this machine to refresh your sign-in.",
      installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    },
    experimental_bridgeOptions: {
      acpLaunchSpec: {
        displayName: "Antigravity",
        command: "agy",
        args: ["acp", "--disable-telemetry"],
        env: {},
      },
      acpDialect: "acp",
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
      permissionModes: ["accept-edits"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    models: { fallback: [], scope: "workspace" },
  });
}

