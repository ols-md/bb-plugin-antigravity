import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { mapPromptMode } from "./prompt-mode.js";

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  handleLine(line: string) {
    experimental_acpProviderBridge.handleLine(mapPromptMode(line));
  },
};
