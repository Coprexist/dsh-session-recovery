#!/usr/bin/env node
/**
 * make-test-fixture.js — generate synthetic damaged session fixtures so you can
 * exercise scripts/repair-session.js offline (no real data, no disk scanning).
 *
 * Two fixtures are written:
 *
 *   test1-session.jsonl.zstd  — in-place damage: a duplicate tool result for
 *       the same call (a compaction rewrite flattened to "append"), an
 *       out-of-range `agent/inbox/spliced`, and a dangling assistant tool call
 *       with no recorded result. Repair with the file alone:
 *         node scripts/repair-session.js <out>/test1-session.jsonl.zstd --dry-run
 *         node scripts/repair-session.js <out>/test1-session.jsonl.zstd
 *
 *   test2-session.jsonl.zstd  — raw faithful-rebuild path: the raw JSONL
 *       contains a VALID compaction REPLACE (tool result rewritten in place,
 *       same message id, content-only change). Repair from the raw events:
 *         node scripts/repair-session.js <out>/test2-session.jsonl.zstd \
 *           --raw <out>/test2-raw.jsonl --dry-run
 *         node scripts/repair-session.js <out>/test2-session.jsonl.zstd \
 *           --raw <out>/test2-raw.jsonl
 *
 * Expected: after repair, both outputs re-decode, fold cleanly under DSH's own
 * surface rules, and produce a provider-valid transcript (every tool result
 * answered by a preceding assistant tool_calls; no duplicate call ids).
 *
 * Usage:
 *   node scripts/make-test-fixture.js [--out-dir DIR]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const arg = name => { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined }
const OUT_DIR = arg('out-dir') || '.'
fs.mkdirSync(OUT_DIR, { recursive: true })

function encodeFrames(lines) {
  return Buffer.concat(lines.map(l =>
    zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
  ))
}
function write(name, header, events) {
  const lines = [JSON.stringify(header), ...events.map(JSON.stringify)]
  fs.writeFileSync(path.join(OUT_DIR, name), encodeFrames(lines))
  console.log('wrote', name, `(${lines.length} lines)`)
}

const H = { type: 'session', version: 0, id: 'test-session-1', createdAt: 1000, cwd: '/tmp/test', delegationDepth: 0, agentPreset: 'standard' }

// ---------------- fixture 1: in-place damage
const t1 = [
  { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1001, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: 2, time: 1002, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'call1', name: 'foo', arguments: '{}' }] } }, surfaceOp: 'append' },
  { type: 'tool/result', seq: 3, time: 1003, data: { turn: 1, step: 1, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'call1' }, content: [{ type: 'tool-result', toolCallId: 'call1', content: [{ type: 'text', text: 'res1-original' }] }] } }, surfaceOp: 'append' },
  // duplicate result for the SAME call (compaction rewrite flattened to "append" = the damage)
  { type: 'tool/result', seq: 4, time: 1004, data: { turn: 1, step: 1, message: { id: 't1b', role: 'user', source: { kind: 'tool', callId: 'call1' }, content: [{ type: 'tool-result', toolCallId: 'call1', content: [{ type: 'text', text: 'res1-pruned' }] }] } }, surfaceOp: 'append' },
  { type: 'user/message', seq: 5, time: 1005, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'again' }] }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 6, time: 1006, data: { turn: 1, reason: { kind: 'done' } } },
  // INVALID inbox splice: start=3 when the next-turn list is empty (state lost)
  { type: 'agent/inbox/spliced', seq: 7, time: 1007, data: { target: 'next-turn', start: 3, removedCount: 1, inserted: [{ id: 'p1', role: 'user', content: [{ type: 'text', text: 'pending?' }] }] } },
  // dangling assistant call (no result) — turn 2 stays open
  { type: 'turn/start', seq: 8, time: 2000, data: { turn: 2 } },
  { type: 'assistant/message', seq: 9, time: 2001, data: { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', id: 'call2', name: 'bar', arguments: '{}' }] } }, surfaceOp: 'append' },
  { type: 'user/message', seq: 10, time: 2002, data: { id: 'u3', role: 'user', content: [{ type: 'text', text: 'then?' }] }, surfaceOp: 'append' },
]
write('test1-session.jsonl.zstd', H, t1)
fs.writeFileSync(path.join(OUT_DIR, 'test1-raw.jsonl'), t1.map(JSON.stringify).join('\n') + '\n')

// ---------------- fixture 2: raw faithful rebuild with a VALID replace
const H2 = { type: 'session', version: 0, id: 'test-session-2', createdAt: 1000, cwd: '/tmp/test', delegationDepth: 0, agentPreset: 'standard' }
const t2 = [
  { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1001, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q' }] }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: 2, time: 1002, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'foo', arguments: '{}' }] } }, surfaceOp: 'append' },
  { type: 'tool/result', seq: 3, time: 1003, data: { turn: 1, step: 1, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r1' }] }] } }, surfaceOp: 'append' },
  // VALID replace: rewrites tool/result seq 3 in place (same message id, content-only change)
  { type: 'tool/result', seq: 4, time: 1004, data: { turn: 1, step: 1, message: { id: 't1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r1-pruned' }] }] } }, surfaceOp: { op: 'replace', start: 3, end: 3 }, sourceEventSeqs: [3] },
  { type: 'user/message', seq: 5, time: 1005, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next' }] }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 6, time: 1006, data: { turn: 1, reason: { kind: 'done' } } },
]
write('test2-session.jsonl.zstd', H2, t2)
fs.writeFileSync(path.join(OUT_DIR, 'test2-raw.jsonl'), t2.map(JSON.stringify).join('\n') + '\n')

console.log('fixtures written to', path.resolve(OUT_DIR))
console.log('try: node scripts/repair-session.js <out>/test1-session.jsonl.zstd --dry-run')
