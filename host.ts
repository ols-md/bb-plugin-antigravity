import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { modeControlOutput } from "./mode-controls.js";
import { mapPromptMode } from "./prompt-mode.js";

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  start() {
    const write = process.stdout.write.bind(process.stdout);
    const output = modeControlOutput();
    output.on("data", chunk => write(chunk));
    process.stdout.write = output.write.bind(output) as typeof process.stdout.write;
  },
  handleLine(line: string) {
    experimental_acpProviderBridge.handleLine(mapPromptMode(line));
  },
};
