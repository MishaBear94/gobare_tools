import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolvePiSession } from './pi-session.js'

test('resolves an explicit local session file without scanning the Pi session store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-tools-test-'))
  const session = join(root, 'session.jsonl')
  try {
    await writeFile(session, '{"type":"session"}\n')
    assert.equal(await resolvePiSession(session), session)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
