import assert from 'node:assert/strict'
import test from 'node:test'
import { createPiImport, downloadPiImportCheckpoint, downloadPiProjectCheckpoint } from './api.js'

test('retries a transient network failure before creating an idempotent Pi import', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new TypeError('fetch failed')
    return Response.json({
      projectId: 'project-1',
      projectUrl: 'https://app.gobare.dev/sessions/project-1',
      transferId: 'transfer-1',
      status: 'created',
      bindingState: 'binding_required',
      created: true,
    })
  }
  try {
    const created = await createPiImport(
      { server: 'https://app.gobare.dev', token: 'gbr_pat_test' },
      {
        transferId: 'transfer-1',
        idempotencyKey: 'idempotency-1',
        projectName: 'Imported project',
        manifest: {
          format: 'gobare-pi-transfer-v1', transferId: 'transfer-1', createdAt: '2026-07-25T00:00:00.000Z',
          safeBoundary: 'terminal', sourcePlatform: 'local_pi',
          pi: { package: 'pi', packageVersion: '1', sourceCommit: 'unknown', sessionFormatVersion: '1' },
          session: { checksum: 'a'.repeat(64), byteLength: 1, piSessionId: 'pi-1' },
        },
      },
    )
    assert.equal(created.projectId, 'project-1')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = original
  }
})

test('downloads a native Pi export only from the scoped CLI endpoint', async () => {
  const original = globalThis.fetch
  let request: Request | undefined
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init)
    return new Response('{"type":"session"}\n', {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    })
  }
  try {
    const bytes = await downloadPiImportCheckpoint({ server: 'https://app.gobare.dev/', token: 'gbr_pat_test' }, 'transfer-1')
    assert.equal(Buffer.from(bytes).toString('utf8'), '{"type":"session"}\n')
    assert.equal(request?.url, 'https://app.gobare.dev/api/cli/pi-imports/transfer-1/export')
    assert.equal(request?.headers.get('authorization'), 'Bearer gbr_pat_test')
  } finally {
    globalThis.fetch = original
  }
})

test('rejects a non-native export response without exposing a body', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('not-jsonl', { headers: { 'content-type': 'text/plain' } })
  try {
    await assert.rejects(
      downloadPiImportCheckpoint({ server: 'https://app.gobare.dev', token: 'gbr_pat_test' }, 'transfer-1'),
      /invalid Pi export response/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test('downloads a native Pi export by the caller-owned Gobare project ID', async () => {
  const original = globalThis.fetch
  let request: Request | undefined
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init)
    return new Response('{"type":"session"}\n', {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    })
  }
  try {
    await downloadPiProjectCheckpoint({ server: 'https://app.gobare.dev', token: 'gbr_pat_test' }, 'project-1')
    assert.equal(request?.url, 'https://app.gobare.dev/api/cli/pi-imports/project/project-1/export')
    assert.equal(request?.headers.get('authorization'), 'Bearer gbr_pat_test')
  } finally {
    globalThis.fetch = original
  }
})
