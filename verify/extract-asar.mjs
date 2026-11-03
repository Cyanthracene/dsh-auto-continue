/**
 * Extract files out of an asar archive without the Electron runtime.
 *
 * The kernel ships its packages inside `app.asar`, which is a single file: it
 * cannot be linked to, cannot be listed with `Get-ChildItem`, and cannot be read
 * by a plain Node process. Reading the kernel's own source is the difference
 * between designing against a documented contract and guessing at it, so this
 * small extractor is kept next to the suite rather than thrown away.
 *
 * Usage:
 *   node verify/extract-asar.mjs <app.asar> <outDir> [pathRegex]
 *
 * `pathRegex` is matched against each entry's archive-relative path, e.g.
 * `node_modules/@deepseek-ai/dsh-settings/` to take one package. Omit it at your
 * peril: the full archive is ~11k files and ~112 MiB.
 *
 * Windows note: the archive moved into is not modified, and nothing is written
 * outside `outDir`.
 */
import fs from 'node:fs'
import path from 'node:path'

const asar = process.argv[2]
const outDir = process.argv[3]
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null

if (!asar || !outDir) {
  console.error('usage: node verify/extract-asar.mjs <app.asar> <outDir> [pathRegex]')
  process.exit(2)
}

const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(headerSize)
fs.readSync(fd, jsonBuf, 0, headerSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const base = 16 + headerSize
const unpackedRoot = asar + '.unpacked'

let files = 0
let bytes = 0

const walk = (node, prefix) => {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const entry = prefix + '/' + name
    if (value.files) {
      walk(value, entry)
      continue
    }
    if (value.size === undefined || value.offset === undefined) continue
    if (filter && !filter.test(entry)) continue
    const dest = path.join(outDir, entry)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (value.unpacked) {
      const src = path.join(unpackedRoot, entry)
      if (fs.existsSync(src)) fs.copyFileSync(src, dest)
      continue
    }
    const size = Number(value.size)
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, base + Number(value.offset))
    fs.writeFileSync(dest, buf)
    files++
    bytes += size
  }
}

walk(header, '')
fs.closeSync(fd)
console.log(`extracted ${files} files, ${(bytes / 1048576).toFixed(1)} MiB -> ${outDir}`)
