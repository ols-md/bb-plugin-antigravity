import { createInterface } from 'node:readline';
import { experimental_providerBridge } from './isolated-host.mjs';

for await (const line of createInterface({ input: process.stdin })) {
  experimental_providerBridge.handleLine(line);
}
