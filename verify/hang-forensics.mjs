/**
 * Read-only forensics for a session log that appeared to hang the UI.
 *
 * Prints the durable timeline in order, so the last thing the session actually
 * recorded before the app was force-quit is visible — including whether the host
 * was still writing events (a live-but-unresponsive host) or had stopped
 * mid-turn (a dead one). Frame decoding mirrors the loader: split on the zstd
 * magic, decompress each frame, skip the header record.
 *
 * Usage: node verify/hang-forensics.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node verify/hang-forensics.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

const raw = readFileSync(file)
const offsets = []
for (let at = raw.indexOf(MAGIC); at !== -1; at = raw.indexOf(MAGIC, at + 1)) offsets.push(at)

const records = []
let badFrames = 0
for (let i = 0; i < offsets.length; i++) {
  const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
  try {
    for (const line of zstdDecompressSync(raw.subarray(offsets[i], end)).toString('utf8').split('\n')) {
      if (line.trim()) records.push(JSON.parse(line))
    }
  } catch {
    badFrames += 1
  }
}

const t = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(11, 23) : '--:--:--.---')
console.log(`file      ${file}`)
console.log(`frames    ${offsets.length} (${badFrames} undecodable)`)
console.log(`records   ${records.length}`)
const times = records.map((r) => r.time).filter((x) => typeof x === 'number')
if (times.length > 0) {
  console.log(`span      ${t(Math.min(...times))} -> ${t(Math.max(...times))}  (${((Math.max(...times) - Math.min(...times)) / 1000).toFixed(1)} s)`)
}
console.log('')

/** One summary line per record, with the fields that matter for a stall. */
function describe(record) {
  const event = record.event ?? record
  const data = event.data ?? record.data ?? {}
  const type = String(event.type ?? record.type ?? '?')
  const head = `seq=${String(event.seq ?? record.seq ?? '-').padStart(5)} ${t(event.time ?? record.time)} ${type}`
  switch (type) {
    case 'user/message': {
      const kind = data.source?.kind ?? '(no source.kind)'
      const text = (data.content ?? []).map((b) => b.text ?? `<${b.type}>`).join(' ')
      return `${head}  kind=${kind} id=${data.id ?? '(none)'} role=${data.role ?? '(none)'} :: ${text.slice(0, 110)}`
    }
    case 'turn/start': return `${head}  turn=${data.turn}`
    case 'turn/end': return `${head}  turn=${data.turn} reason=${JSON.stringify(data.reason)}`
    case 'step/start': return `${head}  t${data.turn}/s${data.step}`
    case 'step/end': return `${head}  t${data.turn}/s${data.step}`
    case 'assistant/attempt': {
      const chunks = Array.isArray(data.stream) ? data.stream : []
      const types = [...new Set(chunks.map((c) => c?.chunk?.type ?? '?'))]
      const finish = chunks.find((c) => c?.chunk?.type === 'finish')?.chunk
      return `${head}  t${data.turn}/s${data.step} chunks=[${types.join(',')}] finish=${finish?.reason?.kind ?? '?'}`
    }
    case 'assistant/message': return `${head}  t${data.turn}/s${data.step} blocks=${(data.message?.content ?? []).map((b) => b.type).join(',')}`
    case 'tool/call': return `${head}  ${data.name}`
    case 'tool/result': return `${head}  ${data.name ?? ''} ${data.error === undefined ? 'ok' : `ERROR ${JSON.stringify(data.error).slice(0, 90)}`}`
    case 'request/header': return `${head}  maxTokens=${data.header?.config?.maxTokens ?? 'unset'} reason=${JSON.stringify(data.reason)}`
    case 'agent/inbox/spliced': return `${head}  target=${data.target} inserted=${(data.inserted ?? []).length} ids=[${(data.inserted ?? []).map((m) => m.id ?? '(none)').join(',')}]`
    default: return `${head}  ${JSON.stringify(Object.keys(data)).slice(0, 90)}`
  }
}

// The tail is what matters for a stall, plus a per-type census.
console.log('--- last 60 records ---')
for (const record of records.slice(-60)) console.log(describe(record))

const census = new Map()
for (const record of records) {
  const type = String((record.event ?? record).type ?? record.type ?? '?')
  census.set(type, (census.get(type) ?? 0) + 1)
}
console.log('\n--- type census ---')
for (const [type, count] of [...census].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${type}`)

console.log('\n--- turn/end reasons ---')
for (const record of records) {
  const event = record.event ?? record
  if (event.type !== 'turn/end') continue
  const data = event.data ?? {}
  console.log(`  turn ${String(data.turn).padStart(3)}  ${t(event.time)}  ${JSON.stringify(data.reason)}`)
}

console.log('\n--- auto-continue rows ---')
const rows = records.filter((r) => {
  const event = r.event ?? r
  return event.type === 'user/message' && (event.data ?? {}).source?.kind === 'auto-continue'
})
for (const row of rows) {
  const data = (row.event ?? row).data
  console.log(`  seq=${(row.event ?? row).seq}  id=${data.id ?? '(MISSING)'}  role=${data.role ?? '(MISSING)'}  text=${(data.content?.[0]?.text ?? '').slice(0, 60)}`)
}
console.log(`  total: ${rows.length}`)

console.log('\n--- request/header maxTokens series ---')
for (const record of records) {
  const event = record.event ?? record
  if (event.type !== 'request/header') continue
  const data = event.data ?? {}
  console.log(`  ${t(event.time)}  maxTokens=${data.header?.config?.maxTokens ?? 'unset'}  ${JSON.stringify(data.reason).slice(0, 60)}`)
}
