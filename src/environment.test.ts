import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareEnvironment } from './environment.js'

test('requires explicit approval before importing local dotenv files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-environment-test-'))
  try {
    await writeFile(join(root, '.env'), 'APP_DATABASE_URL=postgres://example\nPUBLIC_LABEL=demo\n')
    await assert.rejects(prepareEnvironment(root, false), /environment_source_incomplete/)
    const prepared = await prepareEnvironment(root, true)
    assert.ok(prepared)
    try {
      const payload = JSON.parse(await readFile(prepared.payloadPath, 'utf8')) as { variables: Array<{ key: string }> }
      assert.deepEqual(payload.variables.map((item) => item.key), ['APP_DATABASE_URL', 'PUBLIC_LABEL'])
    } finally {
      await prepared.cleanup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects control-plane credentials even with explicit environment approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-environment-test-'))
  try {
    await writeFile(join(root, '.env'), 'OPENAI_API_KEY=not-allowed\n')
    await assert.rejects(prepareEnvironment(root, true), /control-plane credential/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
