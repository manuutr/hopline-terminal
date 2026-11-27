#!/usr/bin/env node
// Usage:
//   node scripts/release/cli.mjs stage <dir> <percent>   set stagingPercentage in the feeds (100 removes it)
//   node scripts/release/cli.mjs sums <dir>              write SHA256SUMS.txt and a .sha256 per file
//   node scripts/release/cli.mjs refresh <dir>           fix sha512/size in the feeds after files changed
import { existsSync, statSync } from 'node:fs'
import { checksums, refreshFeeds, stage } from './lib.mjs'

const USAGE = 'usage: cli.mjs stage <dir> <percent> | sums <dir> | refresh <dir>'
const [cmd, dir, arg] = process.argv.slice(2)

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

if (!cmd || !dir) fail(USAGE)
if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`not a directory: ${dir}`)

try {
  switch (cmd) {
    case 'stage': {
      if (arg === undefined) fail(USAGE)
      const written = stage(dir, arg)
      if (!written.length) fail(`no feed files (latest*.yml, beta*.yml) in ${dir}`)
      const pct = Number(arg)
      for (const f of written) console.log(`${f}: ${pct === 100 ? 'everyone (stagingPercentage removed)' : `stagingPercentage ${pct}`}`)
      break
    }
    case 'sums': {
      const rows = await checksums(dir)
      console.log(`SHA256SUMS.txt: ${rows.length} file(s)`)
      for (const r of rows) console.log(r)
      break
    }
    case 'refresh': {
      const changed = await refreshFeeds(dir)
      if (!changed.length) console.log('feeds already match the files')
      for (const c of changed) console.log(`updated ${c}`)
      break
    }
    default:
      fail(USAGE)
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
}
