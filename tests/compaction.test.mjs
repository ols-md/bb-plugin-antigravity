import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCompactionVerifier } from '../compaction.ts';

const compact = { type: 'text', text: '/compact', mentions: [{ start: 0, end: 8, resource: {
  kind: 'command', trigger: '/', name: 'compact', source: 'command', origin: 'builtin', label: 'compact', argumentHint: null,
} }] };
const session = '12345678-1234-1234-1234-123456789012';
const input = { type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 2, content: '<USER_REQUEST>\n/compact\n</USER_REQUEST>' };
const checkpoint = { type: 'CHECKPOINT', source: 'SYSTEM', status: 'DONE', step_index: 3 };
const records = (...rows) => rows.map(row => JSON.stringify(row) + '\n').join('');

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'compact-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, '.gemini', 'antigravity-cli', 'brain', session, '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const verifier = createCompactionVerifier(home);
  const request = { id: 1, method: 'turn/start', params: {
    threadId: 'thread', providerThreadId: session, clientRequestId: 'creq_23456789ab', input: [compact],
    options: { permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation: 'ask' },
  } };
  function emit(...deltas) {
    verifier.verify({ method: 'thread/delta', params: { threadId: 'thread', deltas } });
    return deltas;
  }
  function start() {
    assert.equal(verifier.prepare(request), undefined);
    emit({ kind: 'item.open', key: { channel: 'compaction' } });
  }
  const finish = () => emit({ kind: 'context.compacted' }, { kind: 'turn.boundary', status: 'completed' });
  return { file, verifier, request, start, finish, emit };
}

test('manual compaction requires a new system checkpoint for this command', t => {
  const { file, start, finish } = fixture(t);
  writeFileSync(file, records(input, checkpoint));
  for (const addition of ['', records(input), records(input, { ...checkpoint, source: 'MODEL' }),
    records(input, { ...checkpoint, status: 'ERROR' }), records({ ...input, content: 'another turn' }, checkpoint)]) {
    start();
    appendFileSync(file, addition);
    assert.deepEqual(finish().map(d => [d.kind, d.status]), [['turn.boundary', 'failed']]);
  }
  start();
  appendFileSync(file, records(input, checkpoint));
  assert.deepEqual(finish().map(d => d.kind), ['context.compacted', 'turn.boundary']);
  start();
  appendFileSync(file, records(input, { type: 'SYSTEM_MESSAGE', source: 'SYSTEM', step_index: 3 },
    { ...checkpoint, step_index: 4 }));
  assert.equal(finish()[0].kind, 'context.compacted');
});

test('empty history, duplicate requests, cancellation and bridge rejection permit a later retry', t => {
  const { file, verifier, request, start, emit } = fixture(t);
  assert.match(verifier.prepare(request), /Complete a conversation turn/);
  writeFileSync(file, records(input));
  start();
  assert.match(verifier.prepare({ ...request, id: 2 }), /already in progress/);
  assert.deepEqual(emit({ kind: 'turn.boundary', status: 'interrupted' }), [{ kind: 'turn.boundary', status: 'interrupted' }]);
  assert.equal(verifier.prepare(request), undefined);
  verifier.verify({ id: 1, error: { message: 'No active ACP session' } });
  start();
});

test('a stop or discard cannot bypass verification when the CLI ends the turn normally', t => {
  const { file, verifier, start, finish } = fixture(t);
  writeFileSync(file, records(input));
  for (const method of ['thread/stop', 'thread/discard']) {
    start();
    verifier.prepare({ method, id: 2, params: { threadId: 'thread', intent: 'interrupt' } });
    assert.deepEqual(finish().map(d => [d.kind, d.status]), [['turn.boundary', 'failed']]);
  }
});

test('same-thread starts cannot race the SDK while it applies session options', t => {
  const { file, verifier, request, start, finish } = fixture(t);
  writeFileSync(file, records(input));
  const ordinary = { ...request, id: 2, params: { ...request.params, input: [{ type: 'text', text: 'hello' }] } };
  assert.equal(verifier.prepare(ordinary), undefined);
  assert.match(verifier.prepare(request), /Wait for the current turn/);
  verifier.verify({ id: 2, result: { threadId: 'thread' } });
  start();
  assert.match(verifier.prepare(ordinary), /compaction is already in progress/);
  finish();
  assert.equal(verifier.prepare(ordinary), undefined);
});

test('an acknowledgment of a redundant release cannot consume an interrupt in progress', t => {
  const { file, verifier, start, finish } = fixture(t);
  writeFileSync(file, records(input));
  start();
  const params = { threadId: 'thread', providerThreadId: session, activeTurnId: null };
  verifier.prepare({ method: 'thread/stop', id: 2, params: { ...params, intent: 'interrupt' } });
  verifier.prepare({ method: 'thread/stop', id: 3, params: { ...params, intent: 'release' } });
  verifier.verify({ id: 3, result: { ok: true } });
  assert.deepEqual(finish().map(d => [d.kind, d.status]), [['turn.boundary', 'failed']]);
});

test('a routed compaction cannot use the default profile transcript', t => {
  const { file, verifier, request } = fixture(t);
  writeFileSync(file, records(input, checkpoint));
  assert.match(verifier.prepare(request, true), /requires the default Antigravity profile/);
  assert.equal(verifier.prepare(request), undefined);
});
