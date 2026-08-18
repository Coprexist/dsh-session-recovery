#!/usr/bin/env node
/**
 * repair-session.js — validate + repair a dsh session.jsonl.zstd so that it
 * resumes cleanly and produces a provider-valid transcript.
 *
 * Why this exists
 * ---------------
 * A session rebuilt from recovered frames (see scan-zstd.js / rebuild-session.js)
 * can carry two classes of latent damage that only show up at RESUME time:
 *
 *   1. INBOX SPLICE SKEW — `agent/inbox/spliced` events are a stateful
 *      projection. If any splice (or any other event) was lost during
 *      recovery, later splices replay out of bounds and DSH throws
 *      `invalid persisted inbox splice at session seq N`.
 *
 *   2. ORPHANED / DUPLICATED TOOL RESULTS — the log records tool-result
 *      rewrites (compaction pruning) as surface REPLACE ops. A rebuild that
 *      flattens every replace to "append" leaves the OLD result in the
 *      transcript next to the NEW one, so the model API rejects the request
 *      with `Messages with role 'tool' must be a response to a preceding
 *      message with 'tool_calls'`.
 *
 * This script replays the exact same rules DSH uses (surface fold from
 * dsh-session, inbox projection from dsh-agent, wire serialization from
 * dsh-llm-deepseek), reports every violation, and repairs the file:
 *   - rewrites invalid inbox splices to the closest valid splice
 *   - drops duplicate/orphaned tool results (keeps the LAST occurrence,
 *     which is the compaction rewrite)
 *   - synthesizes error tool results for assistant tool calls that have no
 *     recorded result (same message text as DSH's interruptedTurnClosers)
 *   - renumbers seq contiguously, remaps sourceEventSeqs / messageSeqs and
 *     surfaceOp replace ranges, strips surface metadata from non-surface
 *     events, and rewrites per-line checksummed zstd frames
 *
 * Usage:
 *   node scripts/repair-session.js <session.jsonl.zstd> [--raw sess-A.jsonl] [--dry-run] [--out file]
 *
 *   --raw        rebuild faithfully from the recovered raw JSONL (preserves
 *                compaction REPLACE semantics); otherwise repairs the current
 *                file in place.
 *   --dry-run    analyze and report only; write nothing.
 *
 * Output: <file>.repaired (new file) + <file>.bak-<ts> (backup of input).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// ---------------- args
const args = process.argv.slice(2)
function opt(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}
const FILE = args[0]
const RAW = opt('raw')
const DRY = args.includes('--dry-run')
const OUT = opt('out')
if (!FILE) {
  console.error('usage: node repair-session.js <session.jsonl.zstd> [--raw sess-A.jsonl] [--dry-run] [--out file]')
  process.exit(2)
}

// ---------------- zstd framing (mirrors dsh's own scanner)
const ZSTD_MAGIC = 0xFD2FB528
const MAGIC_B = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Structural scan for one complete zstd frame starting at buf[start]; returns frame end offset or -1. */
function frameEnd(buf, start) {
  let o = start
  if (buf.length - o < 4) return -1
  if (buf.readUInt32LE(o) !== ZSTD_MAGIC) return -1
  o += 4
  if (buf.length - o < 1) return -1
  const desc = buf.readUInt8(o); o += 1
  if ((desc & 0x18) !== 0) return -1
  const csFlag = desc >>> 6
  const single = (desc & 0x20) !== 0
  const checksum = (desc & 0x04) !== 0
  const dFlag = desc & 0x03
  const dBytes = dFlag === 3 ? 4 : dFlag
  const csBytes = csFlag === 0 ? (single ? 1 : 0) : 1 << csFlag
  const rem = (single ? 0 : 1) + dBytes + csBytes
  if (buf.length - o < rem) return -1
  o += rem
  for (;;) {
    if (buf.length - o < 3) return -1
    const bh = buf.readUIntLE(o, 3); o += 3
    const last = (bh & 1) !== 0
    const bt = (bh >>> 1) & 0x03
    const bs = bh >>> 3
    if (bt === 3) return -1
    const pl = bt === 1 ? 1 : bs
    if (buf.length - o < pl) return -1
    o += pl
    if (last) break
  }
  if (checksum) { if (buf.length - o < 4) return -1; o += 4 }
  return o
}

function decodeFrames(buf) {
  const frames = []
  let i = 0
  while (i < buf.length) {
    const idx = buf.indexOf(MAGIC_B, i)
    if (idx === -1) break
    const end = frameEnd(buf, idx)
    if (end <= 0) { i = idx + 1; continue }
    frames.push({ start: idx, end })
    i = end
  }
  const lines = []
  for (const f of frames) {
    try {
      lines.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').trim())
    } catch (e) {
      lines.push(null)
    }
  }
  return { frames, lines }
}

function encodeFrames(lines) {
  return Buffer.concat(lines.map(l =>
    zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
  ))
}

// ---------------- parse input
const buf = fs.readFileSync(FILE)
const { frames, lines } = decodeFrames(buf)
console.log(`decoded ${lines.length} frames (${(buf.length / 1024).toFixed(1)} KB, ${frames.length} structural frames)`)

const parsed = lines.map((l, i) => {
  if (l === null) return { raw: l, j: null, err: true }
  try { return { raw: l, j: JSON.parse(l) } } catch (e) { return { raw: l, j: null, err: true } }
})
const header = parsed[0]
if (!header || !header.j || header.j.type !== 'session') {
  console.error('FATAL: first line is not a session header')
  process.exit(1)
}
const events = []
for (let i = 1; i < parsed.length; i++) {
  if (!parsed[i].j) { console.error(`  WARN: line ${i} not valid JSON — skipped`) ; continue }
  events.push(parsed[i].j)
}
console.log(`header: id=${header.j.id} cwd=${header.j.cwd} createdAt=${header.j.createdAt}`)
console.log(`events: ${events.length}`)

// seq contiguity on the current file
let seqGaps = 0
for (let i = 0; i < events.length; i++) {
  if (events[i].seq !== i) { if (seqGaps < 5) console.error(`  seq gap at index ${i}: seq=${events[i].seq}`); seqGaps++ }
}
if (seqGaps) console.error(`  seq contiguity violations in input: ${seqGaps}`)
else console.log('  input seq contiguous: OK')

// ---------------- shared helpers
const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])
const isSurface = t => SURFACE.has(t)

function flattenText(blocks) {
  return (blocks || []).filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Deep structural equality over the JSON value domain (mirrors dsh-session). */
function isDeepEqualJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isDeepEqualJson(item, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson(a[key], b[key]))
}

/** Mirror dsh-session's assertToolResultRewrite: a tool/result REPLACE must
 * rewrite exactly one current tool/result and may change only content. */
function toolResultRewriteOk(orig, repl) {
  if (orig.type !== 'tool/result' || repl.type !== 'tool/result') return false
  const oMsg = orig.data && orig.data.message
  const rMsg = repl.data && repl.data.message
  if (!oMsg || !rMsg || !Array.isArray(oMsg.content) || !Array.isArray(rMsg.content)) return false
  const oBlock = oMsg.content[0]
  const rBlock = rMsg.content[0]
  if (!oBlock || !rBlock) return false
  const oRest = { ...orig.data, message: { ...oMsg, content: [{ ...oBlock, content: null }] } }
  const rRest = { ...repl.data, message: { ...rMsg, content: [{ ...rBlock, content: null }] } }
  return isDeepEqualJson(oRest, rRest)
}

/** Faithful surface fold; invalid replaces degrade to append (recorded). */
function fold(evs) {
  const bySeq = new Map(evs.map(ev => [ev.seq, ev]))
  const nodes = []
  const problems = []
  for (const ev of evs) {
    if (!isSurface(ev.type)) continue
    const op = ev.surfaceOp
    if (op === 'append') { nodes.push(ev.seq); continue }
    if (op && typeof op === 'object' && op.op === 'replace' && typeof op.start === 'number' && typeof op.end === 'number') {
      const si = nodes.indexOf(op.start)
      const ei = nodes.indexOf(op.end)
      if (si === -1 || ei === -1 || si > ei) {
        problems.push({ seq: ev.seq, type: 'replace-range', start: op.start, end: op.end })
        nodes.push(ev.seq)
      } else if (ev.type === 'tool/result') {
        const shadowed = nodes.slice(si, ei + 1)
        const ok = shadowed.length === 1 &&
          toolResultRewriteOk(bySeq.get(shadowed[0]) || { type: null }, ev)
        if (ok) {
          nodes.splice(si, ei - si + 1, ev.seq)
        } else {
          problems.push({ seq: ev.seq, type: 'tool-rewrite' })
          nodes.push(ev.seq)
        }
      } else {
        nodes.splice(si, ei - si + 1, ev.seq)
      }
      continue
    }
    problems.push({ seq: ev.seq, type: 'surfaceOp', op: op })
    nodes.push(ev.seq)
  }
  return { nodes, problems }
}

/** Wire serialization — mirrors dsh-llm-deepseek serializeMessages exactly. */
function wireOf(evs, nodes) {
  const nodeSet = new Set(nodes)
  const wire = []
  for (const ev of evs) {
    if (!nodeSet.has(ev.seq)) continue
    if (ev.type === 'assistant/message') {
      const m = ev.data && ev.data.message
      if (!m || !Array.isArray(m.content) || m.content.length === 0) continue
      const callIds = m.content.filter(b => b.type === 'tool-call').map(b => b.id)
      wire.push({ role: 'assistant', callIds, seq: ev.seq })
    } else if (ev.type === 'user/message') {
      const blocks = (ev.data && ev.data.content) || []
      const toolResults = blocks.filter(b => b.type === 'tool-result')
      const text = flattenText(blocks)
      if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', seq: ev.seq })
      for (const r of toolResults) wire.push({ role: 'tool', toolCallId: r.toolCallId, seq: ev.seq })
    } else if (ev.type === 'tool/result') {
      const b = ev.data && ev.data.message && ev.data.message.content && ev.data.message.content[0]
      wire.push({ role: 'tool', toolCallId: b ? (b.toolCallId || (ev.data.message.source && ev.data.message.source.callId)) : undefined, seq: ev.seq })
    }
  }
  return wire
}

/** Raw pairing report (every bad tool message, incl. duplicates). */
function pairingReport(wire) {
  const pending = new Map()
  const badTool = []
  for (const w of wire) {
    if (w.role === 'assistant') {
      for (const id of w.callIds || []) if (id !== undefined && !pending.has(id)) pending.set(id, w.seq)
    } else if (w.role === 'tool') {
      const id = w.toolCallId
      if (id !== undefined && pending.has(id)) pending.delete(id)
      else badTool.push({ seq: w.seq, toolCallId: id === undefined ? '(none)' : id })
    }
  }
  return { badTool, dangling: [...pending.entries()].map(([id, seq]) => ({ callId: id, assistantSeq: seq })) }
}

/** Repair decisions: drop duplicates (keep last) + orphans; list dangling calls. */
function planToolRepairs(wire) {
  const groups = new Map()
  for (const w of wire) {
    if (w.role === 'tool' && w.toolCallId !== undefined) {
      const a = groups.get(w.toolCallId) || []
      a.push(w.seq)
      groups.set(w.toolCallId, a)
    }
  }
  const dropSeqs = new Set()
  for (const [id, seqs] of groups) {
    if (seqs.length > 1) {
      for (const s of seqs.slice(0, -1)) dropSeqs.add(s) // keep the LAST occurrence
    }
  }
  const pending = new Map()
  for (const w of wire) {
    if (dropSeqs.has(w.seq)) continue
    if (w.role === 'assistant') {
      for (const id of w.callIds || []) if (id !== undefined && !pending.has(id)) pending.set(id, w.seq)
    } else if (w.role === 'tool') {
      const id = w.toolCallId
      if (id !== undefined && pending.has(id)) pending.delete(id)
      else if (id !== undefined) dropSeqs.add(w.seq) // orphan: no preceding tool_calls
    }
  }
  return { dropSeqs, dangling: [...pending.entries()].map(([id, seq]) => ({ callId: id, assistantSeq: seq })) }
}

// ---------------- inbox projection (mirrors dsh-agent Inbox)
function inboxValidate(d, state) {
  const target = d.target === 'next-turn' ? 'next-turn' : 'next-step'
  const list = state[target]
  const removedCount = d.removedCount === undefined ? 0 : d.removedCount
  if (d.start === undefined || typeof d.start !== 'number' || !Number.isSafeInteger(d.start) || d.start < 0 || d.start > list.length) {
    return `start=${d.start} out of range [0,${list.length}]`
  }
  if (typeof removedCount !== 'number' || !Number.isSafeInteger(removedCount) || removedCount < 0 || d.start + removedCount > list.length) {
    return `removedCount=${removedCount} exceeds list at start=${d.start} (len=${list.length})`
  }
  const candidate = [...list.slice(0, d.start), ...(Array.isArray(d.inserted) ? d.inserted : []), ...list.slice(d.start + removedCount)]
  const ids = new Set()
  const other = target === 'next-turn' ? state['next-step'] : state['next-turn']
  for (const m of [...candidate, ...other]) {
    if (!m || typeof m.id !== 'string') return `message without string id in splice`
    if (ids.has(m.id)) return `duplicate pending id ${m.id}`
    ids.add(m.id)
  }
  return null
}

function applySplice(d, state) {
  const target = d.target === 'next-turn' ? 'next-turn' : 'next-step'
  const list = state[target]
  const dc = d.removedCount === undefined ? 0 : d.removedCount
  list.splice(d.start, dc, ...(Array.isArray(d.inserted) ? d.inserted : []))
}

function repairSplice(d, state) {
  const target = d.target === 'next-turn' ? 'next-turn' : 'next-step'
  const list = state[target]
  const ts = Math.trunc(d.start)
  const start = Number.isNaN(ts) ? 0 : Math.min(Math.max(ts, 0), list.length)
  const trc = Math.trunc(d.removedCount === undefined ? 0 : d.removedCount)
  const removedCount = Math.min(Math.max(Number.isNaN(trc) ? 0 : trc, 0), list.length - start)
  const pendingIds = new Set([...state['next-turn'], ...state['next-step']].map(m => m.id))
  const seen = new Set()
  const inserted = []
  for (const m of Array.isArray(d.inserted) ? d.inserted : []) {
    if (m && typeof m.id === 'string' && !pendingIds.has(m.id) && !seen.has(m.id)) {
      seen.add(m.id)
      inserted.push(m)
    }
  }
  const out = { target, start }
  if (removedCount > 0) out.removedCount = removedCount
  if (inserted.length > 0) out.inserted = inserted
  return out
}

function replayInbox(evs, mode) {
  const state = { 'next-turn': [], 'next-step': [] }
  const problems = []
  let fixedCount = 0
  for (const ev of evs) {
    if (ev.type !== 'agent/inbox/spliced') continue
    const d = ev.data || {}
    const err = inboxValidate(d, state)
    if (err) {
      if (mode === 'repair') {
        const fixed = repairSplice(d, state)
        ev.data = fixed
        applySplice(fixed, state)
        fixedCount++
      } else {
        problems.push({
          seq: ev.seq,
          err,
          data: JSON.parse(JSON.stringify(d)),
          state: { nt: state['next-turn'].length, ns: state['next-step'].length },
        })
      }
    } else {
      applySplice(d, state)
    }
  }
  return { problems, state, fixedCount }
}

// ---------------- build work list
let workEvents
let sourceDesc
if (RAW) {
  const rawLines = fs.readFileSync(RAW, 'utf8').split('\n').filter(Boolean)
  const rawEvs = []
  let dropped = 0
  for (const l of rawLines) {
    try {
      const j = JSON.parse(l)
      if (j && j.type !== 'session' && typeof j.time === 'number') rawEvs.push(j)
      else dropped++
    } catch (e) { dropped++ }
  }
  rawEvs.sort((a, b) => (a.time - b.time) || (a.seq - b.seq) || 0)
  console.log(`raw source: ${rawEvs.length} events from ${RAW} (${dropped} lines skipped)`)
  workEvents = rawEvs
  sourceDesc = `faithful rebuild from ${RAW}`
} else {
  workEvents = events.map(ev => JSON.parse(JSON.stringify(ev)))
  sourceDesc = 'in-place repair of current file'
}
const workBySeq = new Map(workEvents.map(ev => [ev.seq, ev]))

// ---------------- analyze
const f = fold(workEvents)
const wire = wireOf(workEvents, f.nodes)
const rep = pairingReport(wire)
const plan = planToolRepairs(wire)
const inbox = replayInbox(workEvents, 'report')

console.log('\n=== ANALYSIS (' + sourceDesc + ') ===')
console.log(`surface nodes: ${f.nodes.length} (user+assistant+tool messages in transcript order)`)
console.log(`surface fold problems: ${f.problems.length}`)
for (const p of f.problems.slice(0, 20)) console.log(`  [fold] seq ${p.seq}: ${p.type} ${p.start !== undefined ? 'start=' + p.start + ' end=' + p.end : ''}`)
if (f.problems.length > 20) console.log(`  ... and ${f.problems.length - 20} more`)

console.log(`wire messages: ${wire.length} (assistant=${wire.filter(w => w.role === 'assistant').length}, user=${wire.filter(w => w.role === 'user').length}, tool=${wire.filter(w => w.role === 'tool').length})`)
console.log(`bad tool messages (raw pairing): ${rep.badTool.length}`)
for (const b of rep.badTool.slice(0, 20)) console.log(`  [tool] seq ${b.seq}: tool_call_id=${b.toolCallId}`)
if (rep.badTool.length > 20) console.log(`  ... and ${rep.badTool.length - 20} more`)

console.log(`plan: drop tool results = ${plan.dropSeqs.size}, dangling assistant calls = ${plan.dangling.length}`)
for (const s of plan.dropSeqs) console.log(`  [drop] tool/result seq ${s}`)
for (const d of plan.dangling) console.log(`  [dangling] callId ${d.callId} at assistant seq ${d.assistantSeq}`)

console.log(`inbox splices: ${inbox.problems.length} invalid`)
for (const p of inbox.problems.slice(0, 20)) {
  console.log(`  [inbox] seq ${p.seq}: ${p.err} | state nt=${p.state.nt} ns=${p.state.ns} | data=${JSON.stringify(p.data)}`)
}
if (inbox.problems.length > 20) console.log(`  ... and ${inbox.problems.length - 20} more`)
console.log(`inbox final state: next-turn=${inbox.state['next-turn'].length} next-step=${inbox.state['next-step'].length}`)
for (const m of inbox.state['next-turn']) console.log(`  pending next-turn: ${m.id}`)
for (const m of inbox.state['next-step']) console.log(`  pending next-step: ${m.id}`)

if (DRY) {
  console.log('\nDRY-RUN — no changes written.')
  process.exit(0)
}

// ---------------- repair
console.log('\n=== REPAIR ===')

// 1. drop + synthesize
const dropSet = new Set(plan.dropSeqs)
const insertAfter = new Map()
for (const d of plan.dangling) {
  const aev = workBySeq.get(d.assistantSeq)
  if (!aev) { console.error(`  WARN: assistant seq ${d.assistantSeq} not found — skip synth for ${d.callId}`); continue }
  const text = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.'
  const syn = {
    type: 'tool/result',
    time: aev.time,
    data: {
      turn: aev.data && aev.data.turn,
      step: aev.data && aev.data.step,
      message: {
        id: 'interrupted-tool-result-' + d.callId + '-' + aev.seq,
        role: 'user',
        source: { kind: 'tool', callId: d.callId },
        content: [{
          type: 'tool-result',
          toolCallId: d.callId,
          isError: true,
          content: [{ type: 'text', text }],
        }],
      },
      error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
    },
    surfaceOp: 'append',
  }
  const a = insertAfter.get(aev.seq) || []
  a.push(syn)
  insertAfter.set(aev.seq, a)
}

const finalEvents = []
let dropped = 0
for (const ev of workEvents) {
  if (dropSet.has(ev.seq)) { dropped++; continue }
  finalEvents.push(ev)
  const ins = insertAfter.get(ev.seq)
  if (ins) for (const s of ins) finalEvents.push(s)
}
console.log(`dropped ${dropped} tool/result events, synthesized ${plan.dangling.length} results`)

// 2. renumber
const seqMap = new Map()
finalEvents.forEach((ev, i) => {
  if (typeof ev.seq === 'number') seqMap.set(ev.seq, i)
  ev.seq = i
})

// 3. refix refs + surface metadata
function fixRefs(obj) {
  if (!obj || typeof obj !== 'object') return
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if ((k === 'sourceEventSeqs' || k === 'messageSeqs') && Array.isArray(v)) {
      obj[k] = [...new Set(v.filter(s => seqMap.has(s)).map(s => seqMap.get(s)))]
      if (obj[k].length === 0) delete obj[k]
    } else if (v && typeof v === 'object') {
      fixRefs(v)
    }
  }
}
let degraded = 0
for (const ev of finalEvents) {
  if (!isSurface(ev.type)) {
    delete ev.surfaceOp
    delete ev.sourceEventSeqs
    fixRefs(ev)
    continue
  }
  if (ev.surfaceOp && typeof ev.surfaceOp === 'object' && ev.surfaceOp.op === 'replace') {
    const st = seqMap.get(ev.surfaceOp.start)
    const en = seqMap.get(ev.surfaceOp.end)
    if (st === undefined || en === undefined || st >= ev.seq || en >= ev.seq) {
      ev.surfaceOp = 'append'
      degraded++
    } else {
      ev.surfaceOp.start = st
      ev.surfaceOp.end = en
    }
  }
  fixRefs(ev)
}
if (degraded) console.log(`degraded ${degraded} replace ops to append (range lost)`)

// 4. inbox repair on final list (rewrite invalid splice data in place)
const inboxFinal = replayInbox(finalEvents, 'repair')
console.log(`inbox after repair: fixed ${inboxFinal.fixedCount} splices, ${inboxFinal.problems.length} remaining invalid`)
console.log(`inbox final state: next-turn=${inboxFinal.state['next-turn'].length} next-step=${inboxFinal.state['next-step'].length}`)

// 5. final verification
const f2 = fold(finalEvents)
const w2 = wireOf(finalEvents, f2.nodes)
const p2 = planToolRepairs(w2)
const r2 = pairingReport(w2)
console.log(`verify: surface nodes=${f2.nodes.length} fold problems=${f2.problems.length} bad tool=${r2.badTool.length} drop-plan=${p2.dropSeqs.size} dangling=${p2.dangling.length}`)
for (const p of f2.problems.slice(0, 10)) console.log(`  [verify fold] seq ${p.seq}: ${p.type}`)
for (const b of r2.badTool.slice(0, 10)) console.log(`  [verify tool] seq ${b.seq}: ${b.toolCallId}`)

// 6. write
const outFile = OUT || FILE + '.repaired'
if (path.resolve(outFile) === path.resolve(FILE)) {
  console.error('FATAL: --out must differ from the input file')
  process.exit(1)
}
const outLines = [JSON.stringify(header.j), ...finalEvents.map(ev => JSON.stringify(ev))]
const outBuf = encodeFrames(outLines)
fs.writeFileSync(outFile, outBuf)

const ts = new Date().toISOString().replace(/[:.]/g, '-')
const bakFile = FILE + '.bak-' + ts
fs.copyFileSync(FILE, bakFile)

// sanity: re-decode the output
const { lines: reLines } = decodeFrames(outBuf)
console.log(`wrote ${outFile} (${finalEvents.length} events, ${(outBuf.length / 1024).toFixed(1)} KB)`)
console.log(`backup ${bakFile}`)
console.log(`re-decode check: ${reLines.length} lines (${reLines.filter(l => l !== null).length} valid)`)
if (finalEvents.length + 1 !== reLines.filter(l => l !== null).length) {
  console.error('WARN: re-decode line count mismatch!')
  process.exit(1)
}
console.log('done. Next: cp/mv the repaired file over session.jsonl.zstd, then systemctl restart dsh-web')
