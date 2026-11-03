/**
 * Read a DSH session log and report exactly the two things this plugin cares
 * about: turns that ended at the output ceiling, and continuation rows in the
 * transcript.
 *
 * Format, as measured on 0.2.0-rc.2: `session.v4.jsonl.zstd` opens with one
 * small zstd frame holding a header record, then carries one *more* zstd frame
 * per appended JSONL record. So it is not "a zstd file" in the usual sense —
 * `zstdDecompressSync(wholeFile)` decodes the header frame and stops, silently
 * returning 251 bytes for a 1.3 MiB log. Each frame is decoded separately here,
 * which is also why the frame magic is scanned rather than the stream simply
 * piped through a decompressor.
 *
 * Usage:
 *   node verify/inspect-session.mjs <session-dir-or-file> [--dump]
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** Decode a per-record-frame log, falling back to a single-frame or plain file. */
function readLog(target) {
  const raw = fs.readFileSync(target)
  const offsets = []
  for (let at = raw.indexOf(FRAME_MAGIC, 0); at !== -1; at = raw.indexOf(FRAME_MAGIC, at + 4)) {
    offsets.push(at)
  }
  if (offsets.length === 0) return raw.toString('utf8')
  if (offsets.length === 1) {
    try {
      return zstdDecompressSync(raw).toString('utf8')
    } catch {
      return raw.toString('utf8')
    }
  }
  const parts = []
  let frames = 0
  for (let i = 0; i < offsets.length; i++) {
    const slice = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
      frames += 1
    } catch {
      // A trailing partial frame is normal for a log written up to this instant.
    }
  }
  if (frames === 0) return raw.toString('utf8')
  return parts.join('\n')
}

/** Resolve a directory to its session file. */
function resolveTarget(input) {
  if (fs.statSync(input).isFile()) return input
  for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
    const candidate = path.join(input, name)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`no session log under ${input}`)
}

const input = process.argv[2]
const dump = process.argv.includes('--dump')
if (!input) {
  console.error('usage: node verify/inspect-session.mjs <session-dir-or-file> [--dump]')
  process.exit(2)
}

const target = resolveTarget(input)
const text = readLog(target)
const lines = text.split('\n').filter((line) => line.trim().length > 0)

let turns = 0
let ceilingTurns = 0
let humanMessages = 0
const continuations = []
const endings = new Map()

for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  const event = record.event ?? record
  const type = event.type ?? record.type
  const data = event.data ?? record.data ?? {}
  if (type === 'turn/start') turns += 1
  if (type === 'turn/end') {
    const kind = data?.reason?.kind ?? '(none)'
    endings.set(kind, (endings.get(kind) ?? 0) + 1)
    if (kind === 'max-tokens') ceilingTurns += 1
  }
  if (type === 'user/message') {
    const kind = data?.source?.kind
    if (kind === 'user') humanMessages += 1
    const text = (data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    continuations.push({ kind, form: data?.source?.form, turn: data?.source?.turn, text: text.slice(0, 90) })
  }
}

console.log(`file            : ${target}`)
console.log(`decompressed    : ${(text.length / 1024).toFixed(1)} KiB, ${lines.length} records`)
console.log(`turns           : ${turns}`)
console.log(`endings         : ${[...endings].map(([k, n]) => `${k}=${n}`).join(' ')}`)
console.log(`ceiling endings : ${ceilingTurns}`)
console.log(`human messages  : ${humanMessages}`)
const mine = continuations.filter((row) => row.kind === 'auto-continue')
console.log(`auto-continue   : ${mine.length}`)
for (const [index, row] of continuations.entries()) {
  if (!dump && row.kind !== 'auto-continue') continue
  console.log(`  [${index}] kind=${row.kind} form=${row.form} turn=${row.turn} :: ${row.text}`)
}
