import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadAuthConfig, removeAuthConfig, saveAuthConfig } from './auth-config.js'

type EnvironmentSnapshot = {
  XDG_CONFIG_HOME?: string
  PATH?: string
}

function snapshotEnvironment(): EnvironmentSnapshot {
  return { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PATH: process.env.PATH }
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  if (snapshot.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = snapshot.XDG_CONFIG_HOME
  if (snapshot.PATH === undefined) delete process.env.PATH
  else process.env.PATH = snapshot.PATH
}

async function fakeSecurity(bin: string, body: string): Promise<void> {
  const path = join(bin, 'security')
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  await chmod(path, 0o700)
}

test('uses the system credential store before creating a local fallback file', { concurrency: false }, async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'gobare-auth-system-test-'))
  const environment = snapshotEnvironment()
  try {
    const bin = join(root, 'bin')
    await (await import('node:fs/promises')).mkdir(bin)
    await fakeSecurity(
      bin,
      'case "$1" in add-generic-password) exit 0 ;; find-generic-password) printf "gbr_pat_keychain_fixture_token_0123456789\\n" ;; delete-generic-password) exit 0 ;; *) exit 1 ;; esac',
    )
    process.env.XDG_CONFIG_HOME = join(root, 'config')
    process.env.PATH = `${bin}:${environment.PATH ?? ''}`

    await saveAuthConfig({ server: 'https://app.gobare.dev', token: 'gbr_pat_keychain_fixture_token_0123456789' })
    const config = await loadAuthConfig()
    await assert.rejects(stat(join(root, 'config', 'gobare', 'credentials.json')))

    assert.deepEqual(config, {
      server: 'https://app.gobare.dev',
      token: 'gbr_pat_keychain_fixture_token_0123456789',
    })
  } finally {
    await removeAuthConfig()
    restoreEnvironment(environment)
    await rm(root, { recursive: true, force: true })
  }
})

test('requires explicit opt-in for a locked-down file credential fallback', { concurrency: false }, async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'gobare-auth-file-test-'))
  const environment = snapshotEnvironment()
  try {
    const bin = join(root, 'bin')
    await (await import('node:fs/promises')).mkdir(bin)
    await fakeSecurity(bin, 'exit 1')
    process.env.XDG_CONFIG_HOME = join(root, 'config')
    process.env.PATH = `${bin}:${environment.PATH ?? ''}`

    await assert.rejects(
      saveAuthConfig({ server: 'https://app.gobare.dev', token: 'gbr_pat_fallback_fixture_token_0123456789' }),
      /System credential storage is unavailable/,
    )
    await saveAuthConfig(
      { server: 'https://app.gobare.dev', token: 'gbr_pat_fallback_fixture_token_0123456789' },
      { allowFileCredentials: true },
    )
    const directory = await stat(join(root, 'config', 'gobare'))
    const credentials = await stat(join(root, 'config', 'gobare', 'credentials.json'))
    const config = await loadAuthConfig()

    assert.equal(directory.mode & 0o777, 0o700)
    assert.equal(credentials.mode & 0o777, 0o600)
    assert.equal(config?.token, 'gbr_pat_fallback_fixture_token_0123456789')
  } finally {
    await removeAuthConfig()
    restoreEnvironment(environment)
    await rm(root, { recursive: true, force: true })
  }
})
