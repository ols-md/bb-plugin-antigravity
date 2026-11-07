import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
let promptId;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'fake', version: '1' } });
  if (m.method === 'session/new') reply(m.id, { sessionId: 'fake-session' });
  if (m.method === 'session/prompt') {
    promptId = m.id;
    send({ jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: { sessionId: 'fake-session', toolCall: { toolCallId: 'tool', title: 'Run command', kind: 'execute' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] } });
  }
  if (m.id === 100 && m.result) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(m.result) } } } });
    reply(promptId, { stopReason: 'end_turn' });
  }
});
