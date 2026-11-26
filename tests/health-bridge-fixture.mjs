import { createInterface } from 'node:readline';

const { experimental_providerBridge } = process.argv.includes('--default-task-state')
  ? await import('../host.ts')
  : await import('./isolated-host.mjs');

for await (const line of createInterface({ input: process.stdin })) {
  experimental_providerBridge.handleLine(line);
}
