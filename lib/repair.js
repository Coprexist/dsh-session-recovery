// lib/repair.js — shared repair core for scripts/repair-session.js and the
// dsh command plugin (/session-repair). Pure ESM; depends only on node builtins.
//
// Replays the exact rules DSH uses at resume time:
//   - surface fold          (dsh-session: append / replace semantics)
//   - inbox projection      (dsh-agent: agent/inbox/spliced stateful replay)
//   - wire serialization    (dsh-llm-deepseek: assistant tool_calls ↔ tool messages)
// and repairs the damage a rebuilt session can carry:
//   1. invalid inbox splices  → rewritten to the closest valid splice
//   2. duplicate / orphaned tool results → dropped (keeps the LAST occurrence,
//      which is the compaction rewrite)
//   3. dangling assistant tool calls → a synthesized "interrupted" error result
//      is inserted right after the calling assistant message
// then renumbers seq contiguously, remaps every reference, and rewrites the
// per-line checksummed zstd frames.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

// ---------------- zstd framing (mirrors dsh's own scanner) ----------------
const ZSTD_MAGIC = 0xFD2FB528
const MAGIC_B = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function frameEnd(buf, start) {
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

export function decodeFrames(buf) {
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
    } catch {
      lines.push(null)
    }
  }
  return { frames, lines }
}

export function encodeFrames(lines) {
  return Buffer.concat(lines.map(l =>
    zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
  ))
}

// ---------------- surface fold (faithful; invalid replaces degrade) ----------------
const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])
export const isSurface = t => SURFACE.has(t)

function flattenText(blocks) {
  return (blocks || []).filter(b => b.type === 'text').map(b => b.text).join('')
}

export function isDeepEqualJson(a, b) {
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

/** Mirror dsh-session's assertToolResultRewrite. */
export function toolResultRewriteOk(orig, repl) {
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

export function fold(evs) {
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
        const ok = shadowed.length === 1 && toolResultRewriteOk(bySeq.get(shadowed[0]) || { type: null }, ev)
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
    problems.push({ seq: ev.seq, type: 'surfaceOp', op })
    nodes.push(ev.seq)
  }
  return { nodes, problems }
}

// ---------------- wire serialization (mirrors dsh-llm-deepseek) ----------------
export function wireOf(evs, nodes) {
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
      wire.push({
        role: 'tool',
        toolCallId: b ? (b.toolCallId || (ev.data.message.source && ev.data.message.source.callId)) : undefined,
        seq: ev.seq,
      })
    }
  }
  return wire
}

export function pairingReport(wire) {
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

export function planToolRepairs(wire) {
  const groups = new Map()
  for (const w of wire) {
    if (w.role === 'tool' && w.toolCallId !== undefined) {
      const a = groups.get(w.toolCallId) || []
      a.push(w.seq)
      groups.set(w.toolCallId, a)
    }
  }
  const dropSeqs = new Set()
  for (const [, seqs] of groups) {
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
      else if (id !== undefined) dropSeqs.add(w.seq)
    }
  }
  return { dropSeqs, dangling: [...pending.entries()].map(([id, seq]) => ({ callId: id, assistantSeq: seq })) }
}

// ---------------- inbox projection (mirrors dsh-agent Inbox) ----------------
export function inboxValidate(d, state) {
  const target = d.target === 'next-turn' ? 'next-turn' : 'next-step'
  const list = state[target]
  const removedCount = d.removedCount === undefined ? 0 : d.removedCount
  // DSH's Inbox.apply spreads `...splice.inserted` unconditionally, so the key
  // MUST be present and an array (DSH's own mutate() always writes it, even as
  // []). A splice missing it crashes resume with "invalid persisted inbox
  // splice" even though bounds look fine.
  if (!Array.isArray(d.inserted)) return `inserted must be an array (got ${JSON.stringify(d.inserted)})`
  if (d.start === undefined || typeof d.start !== 'number' || !Number.isSafeInteger(d.start) || d.start < 0 || d.start > list.length) {
    return `start=${d.start} out of range [0,${list.length}]`
  }
  if (typeof removedCount !== 'number' || !Number.isSafeInteger(removedCount) || removedCount < 0 || d.start + removedCount > list.length) {
    return `removedCount=${removedCount} exceeds list at start=${d.start} (len=${list.length})`
  }
  const candidate = [...list.slice(0, d.start), ...d.inserted, ...list.slice(d.start + removedCount)]
  const ids = new Set()
  const other = target === 'next-turn' ? state['next-step'] : state['next-turn']
  for (const m of [...candidate, ...other]) {
    if (!m || typeof m.id !== 'string') return 'message without string id in splice'
    if (ids.has(m.id)) return `duplicate pending id ${m.id}`
    ids.add(m.id)
  }
  return null
}

export function applySplice(d, state) {
  const target = d.target === 'next-turn' ? 'next-turn' : 'next-step'
  const list = state[target]
  const dc = d.removedCount === undefined ? 0 : d.removedCount
  list.splice(d.start, dc, ...(Array.isArray(d.inserted) ? d.inserted : []))
}

export function repairSplice(d, state) {
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
  // DSH's apply spreads `...inserted` unconditionally — always emit the key,
  // even as an empty array (a pure no-op splice is valid).
  const out = { target, start, inserted }
  if (removedCount > 0) out.removedCount = removedCount
  return out
}

export function replayInbox(evs, mode) {
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

// ---------------- session-level helpers ----------------
export function decodeSessionFile(file) {
  const buf = fs.readFileSync(file)
  const { frames, lines } = decodeFrames(buf)
  const parsed = lines.map(l => {
    if (l === null) return { j: null, err: true }
    try { return { j: JSON.parse(l) } } catch { return { j: null, err: true } }
  })
  const header = parsed[0]
  if (!header || !header.j || header.j.type !== 'session') {
    throw new Error(`first line is not a session header: ${file}`)
  }
  const events = []
  const warnings = []
  for (let i = 1; i < parsed.length; i++) {
    if (!parsed[i].j) warnings.push(`line ${i}: invalid JSON (frame skipped)`)
    else events.push(parsed[i].j)
  }
  let gaps = 0
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) gaps++
  }
  if (gaps) warnings.push(`${gaps} seq contiguity violations in input`)
  return { header: header.j, events, lineCount: lines.length, warnings, gaps }
}

/** Recursively locate a session file under <dshHome>/sessions/<...>/<id>/session.jsonl.zstd */
export function findSessionFile(sessionId, dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  const root = path.join(dshHome, 'sessions')
  if (!fs.existsSync(root)) return null
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === sessionId || (e.name === 'session-' + sessionId && !sessionId.startsWith('session-'))) {
          const f = path.join(full, 'session.jsonl.zstd')
          if (fs.existsSync(f)) return f
        }
        stack.push(full)
      }
    }
  }
  return null
}

/** Resolve a user-supplied target to a session file path (null when unknown). */
export function resolveTarget(target, dshHome) {
  if (!target) return null
  if (target.includes('/') || target.includes('\\') || target.includes(':')) {
    const p = path.resolve(target)
    if (fs.existsSync(p)) {
      if (fs.statSync(p).isDirectory()) {
        const f = path.join(p, 'session.jsonl.zstd')
        return fs.existsSync(f) ? f : null
      }
      return p
    }
    return null
  }
  return findSessionFile(target, dshHome)
}

/** Rough character contribution of one surface event (text + tool-call arguments). */
function surfaceCharCount(ev) {
  const blocks = ev.type === 'assistant/message' || ev.type === 'tool/result'
    ? (ev.data && ev.data.message && ev.data.message.content) || []
    : (ev.data && ev.data.content) || []
  let n = 0
  for (const b of blocks) {
    if (b && typeof b.text === 'string') n += b.text.length
    if (b && typeof b.arguments === 'string') n += b.arguments.length
  }
  return n
}

// ---------------- the full repair pipeline ----------------
export function repairFile(file, { raw, dryRun = false, out, compact = false, maxTokens } = {}) {
  const report = []
  const { header, events, warnings, gaps } = decodeSessionFile(file)
  report.push(`decoded ${events.length} events · header id=${header.id}`)
  for (const w of warnings) report.push(`WARN ${w}`)

  let workEvents
  let sourceDesc
  if (raw) {
    const rawLines = fs.readFileSync(raw, 'utf8').split('\n').filter(Boolean)
    const rawEvs = []
    for (const l of rawLines) {
      try {
        const j = JSON.parse(l)
        if (j && j.type !== 'session' && typeof j.time === 'number') rawEvs.push(j)
      } catch { /* skip */ }
    }
    rawEvs.sort((a, b) => (a.time - b.time) || (a.seq - b.seq) || 0)
    workEvents = rawEvs
    sourceDesc = `faithful rebuild from ${raw}`
    report.push(`raw source: ${rawEvs.length} events`)
  } else {
    workEvents = events.map(ev => JSON.parse(JSON.stringify(ev)))
    sourceDesc = 'in-place repair'
  }

  // ---- restore compaction semantics: events that were originally surface
  // REPLACEs carry their shadowed seqs in sourceEventSeqs (a flattening rebuild
  // kept them). Drop those shadowed (already-compacted) messages so the
  // transcript shrinks back to the compacted view the user originally had.
  let compactedDropped = 0
  if (compact) {
    const shadowed = new Set()
    for (const ev of workEvents) {
      if (isSurface(ev.type) && Array.isArray(ev.sourceEventSeqs) && ev.sourceEventSeqs.length > 0) {
        for (const s of ev.sourceEventSeqs) shadowed.add(s)
      }
    }
    if (shadowed.size) {
      workEvents = workEvents.filter(ev => !shadowed.has(ev.seq))
      compactedDropped = shadowed.size
      report.push(`compaction restore: dropped ${compactedDropped} shadowed (already-compacted) messages`)
    } else {
      report.push('compaction restore: no shadowed messages found (nothing to drop)')
    }
  }

  // ---- max-tokens fallback: ONLY if the (possibly compacted) transcript is
  // still over the model budget, drop the OLDEST whole turns until it fits.
  // The turn containing the newest user message is always kept, so a resumed
  // session always has a real user anchor in its transcript.
  let trimmedOldest = 0
  if (maxTokens && Number.isFinite(maxTokens) && maxTokens > 0) {
    const capChars = maxTokens * 1.0 // ~1 char/token worst case (CJK); code/English are cheaper
    const charsBySeq = new Map()
    workEvents.forEach(ev => { if (isSurface(ev.type)) charsBySeq.set(ev.seq, surfaceCharCount(ev)) })
    // group events into turns (turn/start boundaries); events before the first
    // turn/start form a preamble group
    const groups = []
    let cur = null
    workEvents.forEach((ev, i) => {
      if (ev.type === 'turn/start') { cur = { start: i, chars: 0 }; groups.push(cur) }
      else if (cur === null) { cur = { start: 0, chars: 0 }; groups.push(cur) }
      if (isSurface(ev.type) && cur) cur.chars += charsBySeq.get(ev.seq) ?? 0
    })
    for (let k = 0; k < groups.length - 1; k++) groups[k].end = groups[k + 1].start
    if (groups.length) groups[groups.length - 1].end = workEvents.length
    const total = groups.reduce((s, g) => s + g.chars, 0)
    if (total > capChars) {
      // group holding the newest user/message
      let newestUserGroup = -1
      for (let i = workEvents.length - 1; i >= 0; i--) {
        if (workEvents[i].type === 'user/message') {
          newestUserGroup = groups.findIndex(g => i >= g.start && i < g.end)
          break
        }
      }
      if (newestUserGroup === -1) newestUserGroup = groups.length - 1
      const drop = new Set()
      let acc = total
      for (let k = 0; k < groups.length && acc > capChars; k++) {
        if (k === newestUserGroup) continue
        for (let i = groups[k].start; i < groups[k].end; i++) drop.add(workEvents[i].seq)
        acc -= groups[k].chars
      }
      if (drop.size) {
        workEvents = workEvents.filter(ev => !drop.has(ev.seq))
        trimmedOldest = drop.size
        report.push(`max-tokens fallback: dropped ${drop.size} oldest events (whole turns) to fit ${maxTokens} tokens; newest user turn kept`)
      }
    }
  }

  const workBySeq = new Map(workEvents.map(ev => [ev.seq, ev]))

  const f = fold(workEvents)
  const wire = wireOf(workEvents, f.nodes)
  const rep = pairingReport(wire)
  const plan = planToolRepairs(wire)
  const inbox = replayInbox(workEvents, 'report')

  // transcript size estimate (text + tool-call arguments only; CJK-heavy
  // content is roughly 1-1.5 chars/token, code roughly 3-4)
  let totalChars = 0
  for (const w of wire) {
    const ev = workBySeq.get(w.seq)
    if (!ev) continue
    totalChars += surfaceCharCount(ev)
  }
  report.push(`transcript: ${wire.length} messages · ${totalChars} chars · rough ${Math.round(totalChars / 1.5)} tokens (CJK-heavy) / ${Math.round(totalChars / 3.5)} tokens (code-heavy)`)

  report.push(`surface nodes: ${f.nodes.length} · fold problems: ${f.problems.length}`)
  for (const p of f.problems) {
    report.push(`  [fold] seq ${p.seq}: ${p.type}${p.start !== undefined ? ` start=${p.start} end=${p.end}` : ''}`)
  }
  report.push(`wire: ${wire.length} (assistant=${wire.filter(w => w.role === 'assistant').length}, user=${wire.filter(w => w.role === 'user').length}, tool=${wire.filter(w => w.role === 'tool').length})`)
  for (const b of rep.badTool) report.push(`  [tool] seq ${b.seq}: tool_call_id=${b.toolCallId}`)
  report.push(`plan: drop ${plan.dropSeqs.size} tool results · dangling calls: ${plan.dangling.length}`)
  for (const d of plan.dangling) report.push(`  [dangling] callId ${d.callId} at assistant seq ${d.assistantSeq}`)
  report.push(`inbox: ${inbox.problems.length} invalid splices`)
  for (const p of inbox.problems) report.push(`  [inbox] seq ${p.seq}: ${p.err}`)
  report.push(`inbox final: next-turn=${inbox.state['next-turn'].length}, next-step=${inbox.state['next-step'].length}`)

  const stats = {
    events: events.length,
    surfaceNodes: f.nodes.length,
    foldProblems: f.problems.length,
    badTool: rep.badTool.length,
    dropToolResults: plan.dropSeqs.size,
    danglingCalls: plan.dangling.length,
    inboxInvalid: inbox.problems.length,
    transcriptChars: totalChars,
    compactedDropped,
    trimmedOldest,
    source: sourceDesc,
  }

  if (dryRun) {
    report.push('DRY-RUN — no changes written')
    return { dryRun: true, file, report, stats, header }
  }

  // ---- drop + synthesize ----
  const dropSet = new Set(plan.dropSeqs)
  const insertAfter = new Map()
  for (const d of plan.dangling) {
    const aev = workBySeq.get(d.assistantSeq)
    if (!aev) { report.push(`WARN assistant seq ${d.assistantSeq} not found — skip synth for ${d.callId}`); continue }
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
  report.push(`dropped ${dropped} tool/result events · synthesized ${plan.dangling.length} results`)

  // ---- renumber ----
  const seqMap = new Map()
  finalEvents.forEach((ev, i) => {
    if (typeof ev.seq === 'number') seqMap.set(ev.seq, i)
    ev.seq = i
  })

  // ---- refix refs + surface metadata ----
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
  if (degraded) report.push(`degraded ${degraded} replace ops to append (range lost)`)

  // ---- inbox repair on the final list ----
  const inboxFinal = replayInbox(finalEvents, 'repair')
  report.push(`inbox after repair: fixed ${inboxFinal.fixedCount} splices · ${inboxFinal.problems.length} remaining invalid`)
  report.push(`inbox final: next-turn=${inboxFinal.state['next-turn'].length}, next-step=${inboxFinal.state['next-step'].length}`)

  // ---- final verification ----
  const f2 = fold(finalEvents)
  const w2 = wireOf(finalEvents, f2.nodes)
  const r2 = pairingReport(w2)
  const p2 = planToolRepairs(w2)
  report.push(`verify: nodes=${f2.nodes.length} · fold problems=${f2.problems.length} · bad tool=${r2.badTool.length} · drop=${p2.dropSeqs.size} · dangling=${p2.dangling.length}`)
  for (const p of f2.problems.slice(0, 10)) report.push(`  [verify fold] seq ${p.seq}: ${p.type}`)
  for (const b of r2.badTool.slice(0, 10)) report.push(`  [verify tool] seq ${b.seq}: ${b.toolCallId}`)

  // ---- write ----
  const outFile = out || file + '.repaired'
  if (path.resolve(outFile) === path.resolve(file)) {
    throw new Error('--out must differ from the input file')
  }
  const outLines = [JSON.stringify(header), ...finalEvents.map(ev => JSON.stringify(ev))]
  const outBuf = encodeFrames(outLines)
  fs.writeFileSync(outFile, outBuf)

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = file + '.bak-' + ts
  fs.copyFileSync(file, backupFile)

  const { lines: reLines } = decodeFrames(outBuf)
  const valid = reLines.filter(l => l !== null).length
  report.push(`wrote ${outFile} (${finalEvents.length} events) · backup ${backupFile}`)
  if (finalEvents.length + 1 !== valid) {
    report.push('WARN re-decode line count mismatch!')
  } else {
    report.push('re-decode check: OK')
  }

  return {
    dryRun: false,
    file,
    outFile,
    backupFile,
    report,
    stats: { ...stats, finalEvents: finalEvents.length },
    header,
  }
}

/** Compact one-line summary for chat/UI use. */
export function summarize(result) {
  const s = result.stats
  const head = result.dryRun
    ? `🔍 ${s.source}：${s.events} 事件，surface ${s.surfaceNodes} 节点`
    : `🔧 ${s.source}：${s.events} 事件 → ${s.finalEvents} 事件`
  const parts = []
  if (s.foldProblems) parts.push(`surface 问题 ${s.foldProblems}`)
  if (s.badTool) parts.push(`tool 配对问题 ${s.badTool}`)
  if (s.inboxInvalid) parts.push(`inbox splice 异常 ${s.inboxInvalid}`)
  if (s.dropToolResults) parts.push(`丢弃重复/孤儿结果 ${s.dropToolResults}`)
  if (s.danglingCalls) parts.push(`合成缺失结果 ${s.danglingCalls}`)
  if (s.foldProblems === 0 && s.badTool === 0 && s.inboxInvalid === 0) parts.push('无异常')
  return `${head} · ${parts.join('，')}`
}
