/**
 * Print the ordered timeline of the few events that decide whether the ceiling
 * continuation fires: turn boundaries, who ended the turn, and every message
 * that entered the transcript with its source. A `turn/end {max-tokens}`
 * followed by a `user/message {source.kind: 'auto-continue'}` is the plugin
 * working; a `turn/end {max-tokens}` followed by a human message is the
 * "you answered first" race, and one followed by nothing is a drop.
 *
 * Shares the frame-scanning reader with inspect-session.mjs — the log is one
 * zstd frame per appended record, not a single zstd stream.
 *
 * Usage:
 *   node verify/timeline.mjs <session-dir-or-file> [--tail N] [--full]
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

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
  for (let i = 0; i < offsets.length; i++) {
    const slice = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      // trailing partial frame while the session is live — normal
    }
  }
  return parts.length === 0 ? raw.toString('utf8') : parts.join('\n')
}

function resolveTarget(input) {
  if (fs.statSync(input).isFile()) return input
  for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
    const candidate = path.join(input, name)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`no session log under ${input}`)
}

const input = process.argv[2]
if (!input) {
  console.error('usage: node verify/timeline.mjs <session-dir-or-file> [--tail N] [--full]')
  process.exit(2)
}
const tailIndex = process.argv.indexOf('--tail')
const tail = tailIndex === -1 ? 60 : Number(process.argv[tailIndex + 1])
const full = process.argv.includes('--full')

const text = readLog(resolveTarget(input))
const rows = []
let seq = 0

for (const line of text.split('\n')) {
  if (line.trim().length === 0) continue
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  const event = record.event ?? record
  const type = event.type ?? record.type
  const data = event.data ?? record.data ?? {}
  const time = event.time ?? record.time
  if (type === 'turn/start') seq += 1

  if (type === 'turn/end') {
    rows.push({
      seq,
      time,
      what: `turn/end   reason=${data?.reason?.kind ?? '(none)'}`,
      mark: data?.reason?.kind === 'max-tokens' ? 'CEILING' : '',
    })
  } else if (type === 'user/message') {
    const kind = data?.source?.kind ?? '(unknown)'
    const form = data?.source?.form
    const bytes = JSON.stringify(data?.content ?? []).length
    rows.push({
      seq,
      time,
      what: `message    source=${kind}${form ? ` form=${form}` : ''} turn=${data?.source?.turn ?? '-'} bytes=${bytes}`,
      mark: kind === 'auto-continue' ? 'CONTINUED' : kind === 'user' ? 'HUMAN' : '',
    })
  }
}

const shown = full ? rows : rows.slice(-tail)
console.log(`${rows.length} events, showing last ${shown.length}\n`)
for (const row of shown) {
  const stamp = row.time ? new Date(row.time).toISOString().slice(11, 23) : '           '
  console.log(`t${String(row.seq).padStart(2)} ${stamp}  ${row.what.padEnd(62)} ${row.mark}`)
}
