import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { loadAuthConfig, removeAuthConfig, saveAuthConfig } from './auth-config.js'

const execFileAsync = promisify(execFile)
const keychainService = 'dev.gobare.cli'

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', `command -v ${command}`])
    return true
  } catch {
    return false
  }
}

async function withIsolatedConfig<T>(run: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'gobare-system-keyring-test-'))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = root
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
}

test(
  'stores a CLI token in the real macOS Keychain and removes it on logout',
  { skip: process.platform !== 'darwin' },
  async () => {
    await withIsolatedConfig(async () => {
      const server = `https://mac-keychain-${randomUUID()}.gobare.invalid`
      const token = `gbr_pat_macos_keychain_fixture_${randomUUID().replaceAll('-', '')}`
      try {
        await saveAuthConfig({ server, token })
        assert.deepEqual(await loadAuthConfig(), { server, token })
        const stored = await execFileAsync('security', [
          'find-generic-password',
          '-s',
          keychainService,
          '-a',
          server,
          '-w',
        ])
        assert.equal(stored.stdout.trim(), token)
      } finally {
        await removeAuthConfig()
      }
      await assert.rejects(
        execFileAsync('security', [
          'find-generic-password',
          '-s',
          keychainService,
          '-a',
          server,
          '-w',
        ]),
      )
    })
  },
)

test(
  'stores a CLI token in a real Linux Secret Service keyring when explicitly provisioned',
  {
    skip:
      process.platform !== 'linux' ||
      process.env.GOBARE_TOOLS_TEST_SYSTEM_KEYRING !== '1' ||
      !(await commandExists('secret-tool')),
  },
  async () => {
    await withIsolatedConfig(async () => {
      const server = `https://linux-keyring-${randomUUID()}.gobare.invalid`
      const token = `gbr_pat_linux_keyring_fixture_${randomUUID().replaceAll('-', '')}`
      try {
        await saveAuthConfig({ server, token })
        assert.deepEqual(await loadAuthConfig(), { server, token })
        const stored = await execFileAsync('secret-tool', [
          'lookup',
          'service',
          keychainService,
          'server',
          server,
        ])
        assert.equal(stored.stdout.trim(), token)
      } finally {
        await removeAuthConfig()
      }
    })
  },
)
