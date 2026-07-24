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
      assert.match(stdout, /unstaged\.txt/)
      assert.doesNotMatch(stdout, /\.env/)
      const { stdout: restoredOrigin } = await execFileAsync('tar', ['-xOzf', prepared.payloadPath, './.gobare-import/git-origin'])
      assert.equal(restoredOrigin.trim(), 'https://git.example.test/team/repository.git')
      assert.equal((await readFile(prepared.payloadPath, 'utf8').catch(() => '')).includes(credentialedRemote), false)
      assert.ok((await readFile(prepared.payloadPath)).byteLength > 0)
    } finally {
      await prepared.cleanup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
