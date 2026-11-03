/**
 * Count, per session, model requests whose recorded attempt stream is EMPTY —
 * the signature of a completion that spent its whole output budget on hidden
 * reasoning and returned no visible content. Also report the live maxTokens each
 * request header carried. Read-only.
 *
 * Usage: node verify/empty-attempts.mjs <dsh-home> [sinceIso]
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

const home = process.argv[2]
const since = process.argv[3] ? Date.parse(process.argv[3]) : 0
const sessionsDir = path.join(home, 'sessions')
let totalEmpty = 0
let totalAttempts = 0
const capCounts = new Map()
const rows = []

for (const project of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const dir = path.join(sessionsDir, project.name)
  for (const session of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const file = path.join(dir, session.name, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    const stat = fs.statSync(file)
    if (stat.mtimeMs < since) continue
    let text
    try { text = readLog(file) } catch { continue }
    let attempts = 0
    let empty = 0
    const empties = []
    let currentCap = null
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let record
      try { record = JSON.parse(line) } catch { continue }
      const event = record.event ?? record
      const type = String(event.type ?? record.type ?? '')
      const data = event.data ?? record.data ?? {}
      const time = event.time ?? record.time
      if (type === 'request/header') {
        const cap = data?.header?.config?.maxTokens
        currentCap = cap ?? 'unset'
        capCounts.set(String(currentCap), (capCounts.get(String(currentCap)) ?? 0) + 1)
      }
      if (type === 'assistant/attempt') {
        attempts++
        totalAttempts++
        // The durable `assistant/attempt` payload is `{ turn, step, stream }` —
        // there is no `message` field, so reading `data?.message?.content` made
        // every attempt look empty and the tool reported "empty N/N" for every
        // session (measured: 203/203 across the whole store).
        //
        // The stream holds only the attempt's terminal frames. Measured chunk
        // types across 203 real attempts: `finish` (193), `usage` (37),
        // `block-start` (4), `block-end` (1). Text never appears here, so
        // "produced nothing" is decided by whether a content block was opened or
        // any output token was reported — not by looking for text chunks.
        const stream = data?.stream
        const chunks = Array.isArray(stream) ? stream : []
        const chunkTypes = chunks.map((entry) => entry?.chunk?.type ?? '?')
        const openedBlock = chunkTypes.includes('block-start')
        const outputTokens = chunks.reduce((sum, entry) => sum + (Number(entry?.chunk?.usage?.outputTokens) || 0), 0)
        const finished = chunks.find((entry) => entry?.chunk?.type === 'finish')?.chunk ?? undefined
        const failure = finished?.failure ?? data?.error
        const isEmpty = chunks.length === 0 || (!openedBlock && outputTokens === 0)
        if (isEmpty) {
          empty++
          totalEmpty++
          empties.push({
            time,
            turn: data?.turn,
            step: data?.step,
            cap: currentCap,
            note: `${chunks.length === 0 ? 'stream=[]' : `chunks=${chunks.length} outputTokens=${outputTokens}`}`
              + ` types=[${[...new Set(chunkTypes)].join(',')}]`
              + ` finish=${finished?.reason?.kind ?? '?'}`
              + (failure === undefined ? '' : ` failure=${JSON.stringify(failure).slice(0, 90)}`),
          })
        }
      }
    }
    if (empties.length > 0) rows.push({ session: session.name.slice(0, 24), attempts, empty, empties, bytes: stat.size })
  }
}

rows.sort((a, b) => (a.empties[0].time ?? 0) - (b.empties[0].time ?? 0))
for (const row of rows) {
  const t = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : '--:--:--')
  console.log(`\n=== ${row.session}  ${(row.bytes / 1024).toFixed(0)} KB  empty ${row.empty}/${row.attempts} attempts`)
  for (const e of row.empties.slice(0, 10)) console.log(`      [${t(e.time)}] turn=${e.turn} step=${e.step} maxTokens=${e.cap}  ${e.note}`)
}
console.log('\n--- request headers by maxTokens value ---')
for (const [k, v] of [...capCounts].sort((a, b) => b[1] - a[1])) console.log(`  maxTokens=${k}: ${v} requests`)
console.log(`\nempty attempts: ${totalEmpty} / ${totalAttempts} total attempts`)
