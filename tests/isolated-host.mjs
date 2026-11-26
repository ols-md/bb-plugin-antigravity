import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'antigravity-test-host-'));
process.env.BB_ANTIGRAVITY_TASK_STATE_DIR = dir;
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
export const { experimental_providerBridge, rememberApprovalSetting, interceptApproval } = await import('../host.ts');
