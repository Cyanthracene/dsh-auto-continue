/**
 * Regression lock for the message shape this plugin hands to `agent.followup()`,
 * checked against the **real kernel validator** rather than a copy of its rules.
 *
 * ## The defect this locks
 *
 * `continuationMessage()` used to return `{ content, source }` only — no `id`,
 * no `role`. A `user/message` is a message event, and the kernel validates every
 * stored event on load with `adoptSessionEvent()`
 * (`@deepseek-ai/dsh-session`, called from
 * `@deepseek-ai/dsh-session-persistence`'s `validateStoredEvents`). Its rules for
 * this type are: non-empty string `id`, `role === 'user'`, non-empty
 * `source.kind`, array `content`.
 *
 * The kernel's own injected user rows go through `createUserMessage()`, which
 * stamps `id` and `role`; a hand-built payload skips that factory, which is why
 * this plugin could write a log that replays fine in memory and is then
 * **refused at load**:
 *
 *     stored session "session-…" failed validation:
 *     Error: session event at seq 68 lacks an identified message
 *
 * Measured on 2026-11-03: three real sessions, twelve continuations each, every
 * stored row carrying `keys=content,source` and therefore `id=(MISSING)`.
 * Unrecoverable once written — the session no longer opens.
 *
 * ## Why the check is delegated and doubly controlled
 *
 * A re-implementation of the four rules would pass even if the kernel's rules
 * changed, so the real `adoptSessionEvent()` is imported when the kernel runtime
 * is locatable and skipped (loudly) when it is not. The positive control is that
 * the shipped message validates clean; the negative control is that the exact
 * old shape is still refused — without it, an import that silently resolved to
 * something permissive would look like a pass.
 *
 * Point `DEEPSEEK_DSH_RUNTIME_PATH` at the kernel package tree (the directory
 * holding `node_modules/@deepseek-ai`) when the default locations miss.
 *
 * Usage: node verify/probe-message-shape.mjs
 */
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const mod = await import('../lib/index.js')

// ── assertions ──────────────────────────────────────────────────────────────

let checks = 0
let failures = 0

function check(label, condition, detail) {
  checks++
  if (condition) {
    console.log(`  ok   ${label}${detail === undefined ? '' : `   [${detail}]`}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : `   [${detail}]`}`)
  }
}

// ── locate the kernel's own dsh-session ─────────────────────────────────────

/** Candidate kernel roots: the package tree that holds `node_modules/@deepseek-ai`. */
async function kernelCandidates() {
  const out = []
  const override = process.env.DEEPSEEK_DSH_RUNTIME_PATH
  if (override !== undefined && override.length > 0) out.push(override)
  // The desktop install keeps the runtime inside the asar; an extracted copy of
  // that tree above this plugin is the usual development layout, and the walk-up
  // below locates it at whatever depth this copy happens to sit.
  out.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked'))
  return out
}

/**
 * Walk up from this file looking for a sibling extracted kernel runtime.
 *
 * A fixed `../..` would be wrong: the plugin may sit at a different depth (a
 * checkout, a temp copy, a nested workspace), and climbing a fixed number of
 * levels can land on an unrelated tree. The walk stops at the filesystem root.
 * @returns the first ancestor holding `_kernel-root/dsh`, or undefined.
 */
async function findKernelRootAbove() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, '_kernel-root', 'dsh')
    try {
      await access(candidate, constants.R_OK)
      return candidate
    } catch { /* keep climbing */ }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Import `adoptSessionEvent` from the first candidate that carries it.
 * @returns the validator and its path, or a record naming why it is missing.
 *
 * Existence of a `_kernel-root` above this file is *not* itself a failure: an
 * unpacked tree can legitimately sit with no kernel next to it, and this probe
 * ships as a development tool. The precise failure is a kernel root that is
 * there but does not carry the validator, because then the lock cannot be
 * trusted and a plain "SKIP" would retire it silently.
 */
async function loadKernelValidator() {
  const above = await findKernelRootAbove()
  const candidates = await kernelCandidates()
  if (above !== undefined) candidates.push(above)
  for (const root of candidates) {
    if (root === undefined || root === '') continue
    const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
    try {
      await access(pkg, constants.R_OK)
      const imported = await import(pathToFileURL(pkg).href)
      if (typeof imported.adoptSessionEvent === 'function') return { validator: imported.adoptSessionEvent, pkg }
      return { brokenCandidate: pkg }
    } catch { /* try the next candidate */ }
  }
  return { explicitRuntime: process.env.DEEPSEEK_DSH_RUNTIME_PATH !== undefined }
}

// ── checks that need no kernel ──────────────────────────────────────────────

console.log('== the shipped continuation message ==')

const message = mod.continuationMessage('继续。', 7)

check('message carries an id', typeof message.id === 'string' && message.id.length > 0, `id=${String(message.id)}`)
check('message carries role "user" (the kernel requires it for user/message)', message.role === 'user', `role=${String(message.role)}`)
check('message keeps the non-user source kind', message.source?.kind === 'auto-continue')
check('message keeps the presentation form', message.source?.form === 'notice')
check('message records the ending turn', message.source?.turn === 7)
check('message content is one text block', Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === 'text')
check('content and source are the only other keys', JSON.stringify(Object.keys(message).sort()) === JSON.stringify(['content', 'id', 'role', 'source']), Object.keys(message).sort().join(','))

const other = mod.continuationMessage('继续。', 7)
check('two continuations get distinct ids', other.id !== message.id, `${String(message.id).slice(0, 8)} vs ${String(other.id).slice(0, 8)}`)

// The durable log is JSON; an id must survive the round trip unchanged.
const roundTripped = JSON.parse(JSON.stringify(message))
check('the id survives a JSON round trip unchanged', roundTripped.id === message.id)

// ── the real validator, when the kernel runtime is locatable ────────────────

console.log('\n== kernel validator (real adoptSessionEvent) ==')

const loaded = await loadKernelValidator()

if (loaded.brokenCandidate !== undefined) {
  // A kernel root resolved but carries no validator: the lock cannot be trusted,
  // and reporting success here would retire it silently.
  check('the kernel runtime exposes adoptSessionEvent()', false, `${loaded.brokenCandidate} imported without one`)
} else if (loaded.validator === undefined) {
  console.log('  SKIP kernel runtime not found; set DEEPSEEK_DSH_RUNTIME_PATH to the tree holding')
  console.log('       node_modules/@deepseek-ai to run the validator-backed checks.')
  console.log('       The checks above still ran; the validator-backed ones did NOT.')
  if (loaded.explicitRuntime === true) {
    // A named runtime that is not there is a configuration error, not a skip.
    check('the runtime named by DEEPSEEK_DSH_RUNTIME_PATH is usable', false, 'no validator at that path')
  }
} else {
  console.log(`  (validator: ${loaded.pkg})`)
  const event = (data) => ({ type: 'user/message', seq: 68, time: 1, data, surfaceOp: 'append' })

  let adopted
  try {
    adopted = loaded.validator(event(roundTripped))
    check('the shipped message is accepted for the durable log', true, 'adoptSessionEvent() returned')
  } catch (error) {
    check('the shipped message is accepted for the durable log', false, String(error?.message ?? error))
  }
  check('the accepted event carries the same id back', adopted?.data?.id === message.id)

  // Negative control: the exact pre-fix shape must still be refused, otherwise
  // the check above proves nothing about the rules actually being applied.
  const legacy = { content: [{ type: 'text', text: '继续。' }], source: { kind: 'auto-continue', form: 'notice', turn: 7 } }
  let legacyError
  try {
    loaded.validator(event(legacy))
  } catch (error) {
    legacyError = error
  }
  check('the pre-fix shape is still refused (negative control)', legacyError !== undefined, legacyError === undefined ? 'validator accepted it — the check above is vacuous' : String(legacyError.message))
  check('the refusal names the missing identified message', String(legacyError?.message).includes('lacks an identified message'), String(legacyError?.message))
}

// ── summary ─────────────────────────────────────────────────────────────────

console.log('')
if (failures === 0) {
  console.log(`OK: all ${checks} checks passed`)
} else {
  console.log(`FAILED: ${failures} of ${checks} checks failed`)
  process.exitCode = 1
}
