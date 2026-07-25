import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const releaseDir = resolve(root, 'release')
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

await rm(releaseDir, { recursive: true, force: true })
await mkdir(releaseDir, { recursive: true, mode: 0o700 })

const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', releaseDir], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, npm_config_ignore_scripts: 'true' },
})
if (packed.status !== 0) {
  throw new Error(`npm pack failed with exit code ${packed.status ?? 'unknown'}.`)
}

let packageFile
try {
  const output = JSON.parse(packed.stdout)
  packageFile = output[0]?.filename
} catch {
  throw new Error('npm pack did not produce a machine-readable package result.')
}
if (typeof packageFile !== 'string' || !packageFile.endsWith('.tgz')) {
  throw new Error('npm pack did not produce a .tgz release artifact.')
}

const artifactPath = resolve(releaseDir, packageFile)
const artifact = await readFile(artifactPath)
const sha256 = createHash('sha256').update(artifact).digest('hex')
const sourceCommit = process.env.GITHUB_SHA ?? 'local-uncommitted'
const manifest = {
  format: 'gobare-tools-node-release-v1',
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  artifact: packageFile,
  sha256,
  runtime: 'node >=22',
  sourceCommit,
}

await writeFile(resolve(releaseDir, 'SHA256SUMS'), `${sha256}  ${packageFile}\n`, {
  mode: 0o600,
})
await writeFile(resolve(releaseDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
})

const unexpected = (await readdir(releaseDir)).filter(
  (file) => ![packageFile, 'SHA256SUMS', 'release-manifest.json'].includes(file),
)
if (unexpected.length > 0) throw new Error('Release directory contains unexpected artifacts.')

process.stdout.write(`${JSON.stringify(manifest)}\n`)
