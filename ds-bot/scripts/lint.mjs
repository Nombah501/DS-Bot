// Lint with the oxlint that `npm run harness` installs in dev/harness, or that a
// deepseek-harness checkout installs, so ds-bot needs no copy of its own. The places are
// DSH_HARNESS, else dev/harness, else a checkout beside this checkout, else beside the main
// worktree (a git worktree has no deepseek-harness of its own).
// Usage: npm run lint [-- <oxlint options>]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const plugin = resolve(import.meta.dirname, '..')
// Lower this with warning fixes; lint reports the new count without rewriting it.
const warningThreshold = 76
const candidates = [process.env.DSH_HARNESS, join(plugin, 'dev', 'harness'), join(plugin, '..', 'deepseek-harness')]
try {
  const common = execFileSync('git', ['-C', plugin, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
  candidates.push(join(dirname(common), 'deepseek-harness'))
} catch {}
// Node runs oxlint's own script: on Windows it cannot spawn the .cmd shim in node_modules/.bin
// without a shell.
const bin = candidates.filter(Boolean).map(dir => join(dir, 'node_modules', 'oxlint', 'bin', 'oxlint')).find(existsSync)
if (!bin) {
  console.error('lint: no oxlint found; run npm run harness, or set DSH_HARNESS to a deepseek-harness checkout')
  process.exit(2)
}
const args = process.argv.slice(2)
const explicitFormat = args.some(arg => /^(?:--format(?:=|$)|-f)/.test(arg))
// Keep the summary available in agent environments unless a caller selects a formatter.
const format = explicitFormat ? [] : ['--format=default']
const result = spawn(process.execPath, [bin, '-c', '.oxlintrc.json', ...args, ...format, `--max-warnings=${warningThreshold}`, 'index.js', 'web-search.js', 'src', 'dev', 'scripts', 'test'], { cwd: plugin, stdio: ['inherit', 'pipe', 'inherit'] })
result.stdout.pipe(process.stdout)
let summary = ''
if (!explicitFormat) result.stdout.on('data', data => {
  // Only the final summary is needed after streaming diagnostics.
  summary = (summary + data).slice(-1024)
})
result.on('error', error => console.error(`lint: ${error.message}`))
result.on('close', status => {
  const warnings = summary.match(/Found (\d+) warnings? and \d+ errors?\./)?.[1]
  if (warnings !== undefined) {
    const count = Number(warnings)
    if (count > warningThreshold) console.error(`lint: ${count} warnings exceed the stored threshold of ${warningThreshold}`)
    else if (count < warningThreshold && status === 0) console.log(`lint: ${count} warnings are below the stored threshold of ${warningThreshold}; lower warningThreshold in scripts/lint.mjs to ${count} and commit it`)
  }
  process.exitCode = status ?? 1
})
