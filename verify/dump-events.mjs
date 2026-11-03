/**
 * Dump every session record in order, with seq/type/time/summary, so the exact
 * ordering around a ceiling ending can be read off. Read-only.
 *
 * Usage: node verify/dump-events.mjs <session-dir-or-file> [fromSeq] [toSeq]
 */
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const FRAME_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function readLog(target) {
  const raw = fs.readFileSync(target)
  const offsets = []
  for (let at = raw.indexOf(FRAME_MAGIC, 0); at !== -1; at = raw.indexOf(FRAME_MAGIC, at + 4)) offsets.push(at)
  if (offsets.length <= 1) {
    try { return zstdDecompressSync(raw).toString('utf8') } catch { return raw.toString('utf8') }
  }
  const parts = []
  for (let i = 0; i < offsets.length; i++) {
    const slice = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length)
    try { parts.push(zstdDecompressSync(slice).toString('utf8')) } catch { /* partial tail */ }
  }
  return parts.join('\n')
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
const from = process.argv[3] === undefined ? -Infinity : Number(process.argv[3])
const to = process.argv[4] === undefined ? Infinity : Number(process.argv[4])
const text = readLog(resolveTarget(input))

const INTERESTING = /^(turn\/(start|end)|step\/(start|end)|user\/message|agent\/inbox\/|session\/|request\/|llm\/|usage|compact|goal|agent\/(status|error|created|disposed))/

for (const line of text.split('\n')) {
  if (line.trim().length === 0) continue
  let record
  try { record = JSON.parse(line) } catch { continue }
  const event = record.event ?? record
  const seq = event.seq ?? record.seq
  const type = event.type ?? record.type
  if (typeof seq === 'number' && (seq < from || seq > to)) continue
  const time = event.time ?? record.time
  const data = event.data ?? record.data ?? {}
  if (process.argv.includes('--all') || INTERESTING.test(String(type))) {
    let detail = ''
    if (type === 'turn/end') detail = `reason=${data?.reason?.kind}`
    else if (type === 'turn/start' || type === 'step/start' || type === 'step/end') detail = `turn=${data?.turn} step=${data?.step}`
    else if (type === 'user/message') detail = `source=${data?.source?.kind} turn=${data?.source?.turn ?? '-'} len=${JSON.stringify(data?.content ?? []).length}`
    else if (type === 'agent/inbox/spliced') detail = `target=${data?.target} start=${data?.start} removed=${data?.removedCount ?? 0} inserted=${(data?.inserted ?? []).map((m) => m?.source?.kind).join(',')}`
    else if (type === 'agent/status') detail = `status=${data?.status}`
    else detail = JSON.stringify(data).slice(0, 120)
    const stamp = time ? new Date(time).toISOString().slice(11, 23) : '           '
    console.log(`${String(seq).padStart(5)} ${stamp} ${String(type).padEnd(24)} ${detail}`)
  }
}
