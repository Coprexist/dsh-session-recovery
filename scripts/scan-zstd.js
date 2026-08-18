#!/usr/bin/env node
/**
 * scan-zstd.js — scan a raw block device for dsh session zstd frames.
 *
 * dsh session logs (session.jsonl.zstd) are a concatenated stream of zstd
 * frames: one frame per JSONL line, frame magic 0xFD2FB528 (bytes 28 b5 2f fd).
 * After `rm -rf ~/.dsh`, the file is gone from the directory tree but its data
 * blocks usually survive on disk until overwritten. This script scans the raw
 * device, parses structurally-complete frames WITHOUT decompressing them
 * (mirrors dsh's own scanZstdFrames), decodes the ones that pass checksum,
 * and clusters events by disk offset proximity so you can tell sessions apart.
 *
 * Usage:
 *   node scripts/scan-zstd.js /dev/sdX1 > /tmp/session-events.jsonl 2>/tmp/scan.log
 *
 * Output (stdout): one JSON event per line (already validated as a dsh event).
 * Output (stderr): progress + cluster summary.
 *
 * The device is opened read-only; nothing is ever written back to it.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const DEV = process.argv[2]
if (!DEV) { console.error('usage: node scan-zstd.js <block-device>'); process.exit(2) }

const ZSTD_MAGIC = 0xFD2FB528
const MAGIC_B = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CHUNK = 64 * 1024 * 1024
const OVERLAP = 2 * 1024 * 1024

/** Structural scan for one complete zstd frame starting at buf[start]; returns frame end offset or -1. */
function frameEnd(buf, start) {
  let o = start
  if (buf.length - o < 4) return -1
  if (buf.readUInt32LE(o) !== ZSTD_MAGIC) return -1
  o += 4
  if (buf.length - o < 1) return -1
  const desc = buf.readUInt8(o); o += 1
  if ((desc & 0x18) !== 0) return -1 // reserved bits
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

const fd = fs.openSync(DEV, 'r')
const seen = new Set()
const lines = [] // { off, j }
let carry = Buffer.alloc(0)
let off = 0, total = 0

while (true) {
  const buf = Buffer.alloc(CHUNK)
  const n = fs.readSync(fd, buf, 0, CHUNK, off)
  if (n <= 0) break
  const data = Buffer.concat([carry, buf.subarray(0, n)])
  const base = off - carry.length
  let i = data.indexOf(MAGIC_B)
  while (i !== -1) {
    const abs = base + i
    if (!seen.has(abs)) {
      const end = frameEnd(data, i)
      if (end > 0) {
        try {
          const dec = zlib.zstdDecompressSync(data.subarray(i, end))
          const text = dec.toString('utf8')
          for (const raw of text.split('\n')) {
            const s = raw.trim()
            if (!s) continue
            try {
              const j = JSON.parse(s)
              if (j && typeof j.type === 'string') { lines.push({ off: abs, j }); seen.add(abs) }
            } catch (e) { /* not JSON — skip */ }
          }
        } catch (e) { /* corrupt frame — skip */ }
      }
    }
    i = data.indexOf(MAGIC_B, i + 1)
  }
  carry = data.subarray(data.length - OVERLAP)
  off += n; total += n
  if (Math.round(total / 1048576) % 512 === 0) console.error('scanned MB', Math.round(total / 1048576), 'lines', lines.length)
}
console.error('DONE scanned MB', Math.round(total / 1048576), 'JSON lines', lines.length)

// cluster by disk-offset proximity (<=4096 bytes apart = same file)
lines.sort((a, b) => a.off - b.off)
const groups = []
let g = [], prev = null
for (const L of lines) {
  if (prev !== null && L.off - prev.off > 4096) { groups.push(g); g = [] }
  g.push(L); prev = L.off
}
if (g.length) groups.push(g)
groups.sort((a, b) => b.length - a.length)
console.error('groups:', groups.length, '| top sizes:', groups.slice(0, 8).map(x => x.length).join(','))

// emit stdout: raw JSON lines, grouped with a marker comment between groups
for (let gi = 0; gi < groups.length; gi++) {
  const grp = groups[gi]
  console.error(`--- group ${gi}: ${grp.length} lines, disk offset ${grp[0].off}`)
  for (const x of grp) console.log(JSON.stringify(x.j))
}
fs.closeSync(fd)
