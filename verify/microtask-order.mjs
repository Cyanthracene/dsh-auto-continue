/**
 * Minimal, faithful model of the agent-loop's turn-finalization ordering:
 *
 *   try { ... } finally { session.append('turn/end') }     // publishes synchronously
 *   if (!this.inbox.hasPending) return false               // the loop's own question
 *
 * A `session/event` handler that defers its queue mutation to a microtask
 * (as dsh-auto-continue does) queues that microtask *while* the append is
 * publishing. This prints the resulting order and whether the two mechanisms
 * (the loop's own hasPending test, and wakeDriver's wake) can still meet.
 *
 * Run: node verify/microtask-order.mjs
 */

console.log('phase            who                        inbox   note')

const inbox = { nextTurn: [] }
let phase = 'running'

function log(phaseName, who, note) {
  console.log(`${phaseName.padEnd(16)} ${who.padEnd(26)} ${String(inbox.nextTurn.length).padEnd(7)} ${note}`)
}

// ── the plugin's handler, verbatim in shape ────────────────────────────────
const handlers = []
function append(type) {
  log(phase, `append(${type})`, 'publishing synchronously')
  for (const h of handlers) h({ type })
}

handlers.push((event) => {
  if (event.type !== 'turn/end') return
  // delayMs === 0 -> defer to a microtask
  void Promise.resolve().then(() => {
    log(phase, 'microtask', 'handler mutation runs here')
    inbox.nextTurn.push({ source: { kind: 'auto-continue' } })
    log(phase, 'microtask', 'followup() spliced the inbox')
    // this is what followup() -> send(..., wakeup=true) -> wakeDriver() does
    if (phase !== 'idle') {
      log(phase, 'wakeDriver', 'phase is not idle -> latches wakeRequested, returns')
      return
    }
    log(phase, 'wakeDriver', 'phase idle -> would start the next turn')
  })
})

async function turn() {
  phase = 'running'
  log(phase, 'turn()', 'turn opened')
  append('turn/end')
  // the loop's own question, asked synchronously right after the append
  const again = inbox.nextTurn.length > 0
  log(phase, 'inbox.hasPending', `-> ${String(again)}`)
  return again
}

const again = await turn()
// kick(): phase -> idle in the finally, then the latched-wake replay
phase = 'idle'
log(phase, 'kick(): finally', 'phase set to idle')

console.log('\n--- after one more macrotask checkpoint ---')
await new Promise((r) => setTimeout(r, 0))
log(phase, 'settled', `inbox holds ${inbox.nextTurn.length} message(s); turn() returned ${String(again)}`)
