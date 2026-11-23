// Fake `agy acp` reproducing how the CLI handles commands that outlive its 10 s synchronous wait.
// The prompt text selects the scenario:
//   case1  - run_command returns "running as a background task", the prompt ends, and the CLI
//            later wakes the model with an unsolicited turn once the task log reports completion.
//   case2  - the prompt ends while run_command is still in_progress; its completion arrives as a
//            late tool_call_update, followed by the reactive wakeup.
//   daemon - like case1 with IsDaemon: true and no wakeup.
//   never  - like case1, but the task never finishes.
//   steer  - a follow-up prompt answered immediately.
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const taskDir = process.env.FAKE_ACP_TASK_DIR;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = value => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: value } });
const say = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const later = (ms, fn) => setTimeout(fn, ms);

function transcriptFor(scenario) {
  const root = join(taskDir, scenario, '.system_generated');
  mkdirSync(join(root, 'logs'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  const transcript = join(root, 'logs', 'transcript.jsonl');
  writeFileSync(transcript, '');
  const slashed = join(root, 'tasks', 'task-1.log').replace(/\\/g, '/');
  return { transcript, logUri: `file://${slashed.startsWith('/') ? '' : '/'}${slashed}` };
}

function backgroundCommand(scenario, rawInput) {
  const { transcript, logUri } = transcriptFor(scenario);
  update({ sessionUpdate: 'tool_call', toolCallId: `${scenario}-call`, title: 'run_command', kind: 'execute', status: 'in_progress', rawInput });
  update({
    sessionUpdate: 'tool_call_update', toolCallId: `${scenario}-call`, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: `Tool is running as a background task with task id: fake-session/task-1\nTask Description: ${rawInput.toolSummary}\nTask logs are available at: ${logUri}\n` } }],
  });
  return transcript;
}

createInterface({ input: process.stdin }).on('line', input => {
  const m = JSON.parse(input);
  if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake', version: '1' } });
  if (m.method === 'session/new') reply(m.id, { sessionId: 'fake-session' });
  if (m.method !== 'session/prompt') return;
  const text = (m.params?.prompt ?? []).map(part => part.text || '').join('\n');
  if (text.includes('case1')) {
    const transcript = backgroundCommand('case1', { CommandLine: 'npm test', toolSummary: 'Run unit tests' });
    say('Waiting for the tests to finish.');
    reply(m.id, { stopReason: 'end_turn' });
    later(300, () => appendFileSync(transcript, `${JSON.stringify({ content: 'Task id "fake-session/task-1" finished with result: Command exited with code 0' })}\n`));
    later(400, () => say('All tests passed.'));
  } else if (text.includes('case2')) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'case2-call', title: 'run_command', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'npm run e2e', toolSummary: 'Run e2e suite' } });
    say('Waiting for the e2e suite.');
    reply(m.id, { stopReason: 'end_turn' });
    later(300, () => update({ sessionUpdate: 'tool_call_update', toolCallId: 'case2-call', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Command exited with code 0\nOutput:\n42 passed\n' } }] }));
    later(400, () => say('E2E suite passed.'));
  } else if (text.includes('daemon')) {
    backgroundCommand('daemon', { CommandLine: 'npm run dev', toolSummary: 'Start dev server', IsDaemon: true });
    say('Dev server started.');
    reply(m.id, { stopReason: 'end_turn' });
  } else if (text.includes('never')) {
    backgroundCommand('never', { CommandLine: 'npm run soak', toolSummary: 'Soak test' });
    say('Waiting for the soak test.');
    reply(m.id, { stopReason: 'end_turn' });
  } else {
    say('Steer handled.');
    reply(m.id, { stopReason: 'end_turn' });
  }
});
