import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { prepareWorkspace } from './workspace.js'

const execFileAsync = promisify(execFile)

test('captures Git history and worktree state while excluding dotenv files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-workspace-test-'))
  try {
    await execFileAsync('git', ['init', root])
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test User'])
    await writeFile(join(root, 'tracked.txt'), 'first\n')
    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt'])
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'initial'])
    const credentialedRemote = 'https://oauth2:example-token-abcdefghijklmnopqrstuvwxyz@git.example.test/team/repository.git'
    await execFileAsync('git', ['-C', root, 'remote', 'add', 'origin', credentialedRemote])
    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await execFileAsync('git', ['-C', root, 'add', 'tracked.txt'])
    await writeFile(join(root, 'unstaged.txt'), 'working tree\n')
    await writeFile(join(root, '.env'), 'DATABASE_URL=do-not-copy\n')
    const prepared = await prepareWorkspace(root)
    const repeated = await prepareWorkspace(root)
    try {
      assert.equal(prepared.kind, 'git_patch')
      assert.equal(prepared.summary.gitBundleIncluded, true)
      assert.equal(prepared.summary.hasStagedChanges, true)
      const { stdout } = await execFileAsync('tar', ['-tzf', prepared.payloadPath])
      assert.match(stdout, /\.gobare-import\/repository\.bundle/)
      assert.match(stdout, /\.gobare-import\/staged\.patch/)
      assert.match(stdout, /\.gobare-import\/git-head/)
      assert.match(stdout, /\.gobare-import\/git-branch/)
      assert.match(stdout, /\.gobare-import\/git-origin/)
      assert.match(stdout, /\.gobare-import\/untracked\.tgz/)
      assert.match(stdout, /unstaged\.txt/)
      assert.doesNotMatch(stdout, /\.env/)
      const { stdout: restoredOrigin } = await execFileAsync('tar', ['-xOzf', prepared.payloadPath, './.gobare-import/git-origin'])
      assert.equal(restoredOrigin.trim(), 'https://git.example.test/team/repository.git')
      const untrackedOverlay = join(root, 'untracked-overlay.tgz')
      const { stdout: overlayBytes } = await execFileAsync('tar', ['-xOzf', prepared.payloadPath, './.gobare-import/untracked.tgz'], { encoding: 'buffer' })
      await writeFile(untrackedOverlay, overlayBytes)
      const { stdout: untrackedContent } = await execFileAsync('tar', ['-xOzf', untrackedOverlay, './unstaged.txt'])
      assert.equal(untrackedContent, 'working tree\n')
      assert.equal((await readFile(prepared.payloadPath, 'utf8').catch(() => '')).includes(credentialedRemote), false)
      assert.ok((await readFile(prepared.payloadPath)).byteLength > 0)
      assert.equal(prepared.checksum, repeated.checksum)
      assert.equal(prepared.bytes, repeated.bytes)
    } finally {
      await Promise.all([prepared.cleanup(), repeated.cleanup()])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('produces the same archive digest for an unchanged workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-workspace-deterministic-test-'))
  try {
    await writeFile(join(root, 'app.txt'), 'unchanged\n')
    const first = await prepareWorkspace(root)
    const second = await prepareWorkspace(root)
    try {
      assert.equal(first.checksum, second.checksum)
      assert.equal(first.bytes, second.bytes)
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writes a safe runtime manifest from files that actually exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-runtime-manifest-test-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --host', start: 'node server.js', dangerous: 'cat .env' } }))
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await writeFile(join(root, 'Dockerfile'), 'FROM node:22\n')
    const prepared = await prepareWorkspace(root)
    try {
      const { stdout } = await execFileAsync('tar', ['-xOzf', prepared.payloadPath, './.gobare-import/runtime-manifest.json'])
      const runtime = JSON.parse(stdout) as { discoveredFiles: string[]; declaredScripts: string[]; prepare: Array<{ command: string; requiresApproval: boolean }>; attention: string[] }
      assert.deepEqual(runtime.discoveredFiles, ['package.json', 'pnpm-lock.yaml', 'Dockerfile'])
      assert.deepEqual(runtime.declaredScripts, ['dev', 'start'])
      assert.deepEqual(runtime.prepare, [{ id: 'node_pnpm_install', category: 'dependency_install', command: 'pnpm install --frozen-lockfile --ignore-scripts', requiresApproval: true }])
      assert.deepEqual(runtime.attention, ['container_build_requires_approval'])
      assert.equal(JSON.stringify(runtime).includes('vite --host'), false)
      assert.equal(JSON.stringify(runtime).includes('cat .env'), false)
      assert.equal(prepared.runtime.format, 'gobare-runtime-manifest-v2')
    } finally {
      await prepared.cleanup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
