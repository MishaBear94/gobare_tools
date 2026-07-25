import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const releaseDir = resolve(root, 'release')
const manifest = JSON.parse(await readFile(join(releaseDir, 'release-manifest.json'), 'utf8'))

if (
  !manifest ||
  typeof manifest.artifact !== 'string' ||
  typeof manifest.sha256 !== 'string' ||
  typeof manifest.packageName !== 'string'
) {
  throw new Error('Release manifest is invalid.')
}
const artifact = resolve(releaseDir, manifest.artifact)
const digest = createHash('sha256').update(await readFile(artifact)).digest('hex')
if (digest !== manifest.sha256) throw new Error('Release artifact SHA-256 does not match its manifest.')

function execute(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(output)
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? code ?? 'unknown'}.`))
    })
  })
}

const prefix = await mkdtemp(join(tmpdir(), 'gobare-tools-release-verify-'))
try {
  await execute('npm', ['install', '--prefix', prefix, '--ignore-scripts', artifact], root)
  const entrypoint = join(prefix, 'node_modules', ...manifest.packageName.split('/'), 'dist', 'cli.js')
  const output = await execute(process.execPath, [entrypoint, '--help'], root)
  if (!output.includes('gobare pi import')) {
    throw new Error('Installed CLI did not expose the Pi import command.')
  }
  process.stdout.write(
    `${JSON.stringify({ format: 'gobare-tools-release-verify-v1', artifact: manifest.artifact, outcome: 'passed' })}\n`,
  )
} finally {
  await rm(prefix, { recursive: true, force: true })
}
