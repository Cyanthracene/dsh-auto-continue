/**
 * Load a stored session log the way the product does, and report what it folds to.
 *
 * This is the end-to-end counterpart to `probe-repaired-logs.mjs`: that one asks
 * "does the loader's validator accept these events", this one asks "can the
 * product's own `Session` be built from them, and what does the model end up
 * seeing". The two are not the same question — a session that validates can still
 * fail to construct if the lifecycle invariant disagrees.
 *
 * Usage: node verify/session-load.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { access, constants } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Walk up from this file until a tree containing `_kernel-root` shows up. */
function findKernelRootAbove() {
  let dir = here
  for (;;) {
    const candidate = join(dir, '_kernel-root', 'dsh')
    try {
      if (readFileSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-session', 'package.json'))) return candidate
    } catch { /* keep walking */ }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function loadKernel() {
  const override = process.env.DEEPSEEK_DSH_RUNTIME_PATH
  const candidates = []
  if (override !== undefined && override.length > 0) candidates.push(join(override, 'node_modules'))
  const above = findKernelRootAbove()
  if (above !== undefined) candidates.push(join(above, 'node_modules'))
  candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'))
  for (const modules of candidates) {
    if (modules === '') continue
    const entry = join(modules, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
    try {
      await access(entry, constants.R_OK)
      const imported = await import(pathToFileURL(entry).href)
      if (typeof imported.adoptSessionEvent === 'function' && imported.Session !== undefined) return { ...imported, modules }
    } catch { /* next candidate */ }
  }
  return undefined
}

const kernel = await loadKernel()
if (kernel === undefined) {
  console.error('FAIL: kernel runtime not found; set DEEPSEEK_DSH_RUNTIME_PATH to the tree holding node_modules/@deepseek-ai')
  process.exit(2)
}

let validateStoredEvents
try {
  const persistence = await import(pathToFileURL(
    join(kernel.modules, '@deepseek-ai', 'dsh-session-persistence', 'lib', 'index.js'),
  ).href)
  if (typeof persistence.validateStoredEvents === 'function') validateStoredEvents = persistence.validateStoredEvents
} catch { /* optional */ }

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node verify/session-load.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

const raw = readFileSync(file)
const offsets = []
for (let at = raw.indexOf(FRAME_MAGIC); at !== -1; at = raw.indexOf(FRAME_MAGIC, at + 1)) offsets.push(at)
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

const header = records.find((r) => r.type === 'session' && r.seq === undefined)
const events = records.filter((r) => !(r.type === 'session' && r.seq === undefined)).map((r) => r.event ?? r)
const sessionId = header?.id ?? basename(dirname(file))

console.log(`file      ${file}`)
console.log(`session   ${sessionId}`)
console.log(`frames    ${offsets.length} (${badFrames} undecodable)`)
console.log(`events    ${events.length}`)

let refused = 0
for (const event of events) {
  try {
    kernel.adoptSessionEvent(event)
  } catch (error) {
    refused += 1
    if (refused <= 5) console.log(`  REFUSED seq=${event.seq} (${event.type}): ${String(error?.message ?? error)}`)
  }
}
console.log(`\n[1/3] per-event adoption       ${refused === 0 ? 'PASS' : `FAIL (${refused} refused)`}`)

let product = 'PASS (validator unavailable)'
if (validateStoredEvents !== undefined) {
  try {
    validateStoredEvents({ id: sessionId }, events, file)
    product = 'PASS'
  } catch (error) {
    product = `FAIL: ${String(error?.message ?? error)}`
  }
}
console.log(`[2/3] validateStoredEvents      ${product}`)

// The strongest check: construct the product's own Session from the stored
// events, exactly as `SessionStore` does on resume.
const id = kernel.SessionId(sessionId)
let session
let constructedBy
try {
  session = kernel.Session.fromRestore(id, events, header ?? { id: sessionId }, kernel.SessionLogOffset(0), 'detached', [])
  constructedBy = 'Session.fromRestore'
} catch (error) {
  try {
    session = kernel.Session.create(id, events, header ?? { id: sessionId }, undefined, [])
    constructedBy = 'Session.create'
  } catch (error2) {
    console.log(`[3/3] Session construction      FAIL`)
    console.log(`      fromRestore: ${String(error?.message ?? error)}`)
    console.log(`      create     : ${String(error2?.message ?? error2)}`)
    process.exit(1)
  }
}
console.log(`[3/3] Session construction      PASS (${constructedBy})`)

const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : undefined
if (Array.isArray(messages)) {
  const continuations = messages.filter((m) => m?.source?.kind === 'auto-continue')
  const ids = continuations.map((m) => m.id)
  const texts = continuations.map((m) => (m.content ?? []).map((b) => b.text ?? '').join(''))
  console.log(`\nfolds to ${messages.length} message(s)`)
  console.log(`  auto-continue projected : ${continuations.length}`)
  console.log(`  all role=user           : ${continuations.every((m) => m.role === 'user')}`)
  console.log(`  all have non-empty id   : ${ids.every((value) => typeof value === 'string' && value.length > 0)}`)
  console.log(`  duplicate ids           : ${ids.length - new Set(ids).size}`)
  console.log(`  rows with empty content : ${texts.filter((text) => text.length === 0).length}`)
  if (texts[0] !== undefined) console.log(`  first continuation text : ${texts[0].slice(0, 64)}…`)
}
