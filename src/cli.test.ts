import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { confirmPiImport, piImportDryRunResult, runPiImport, runPiImportResume } from './cli.js'
import { createPiImportFixture } from './pi-import-fixture.js'

const runtimeFixture = {
  format: 'gobare-runtime-manifest-v2' as const,
  workspaceRoot: '/home/user/workspace' as const,
  discoveredFiles: [] as string[],
  declaredScripts: [] as Array<'dev' | 'start' | 'test'>,
  prepare: [],
  attention: [],
}

test('dry-run summary contains only migration metadata and no environment values', () => {
  const summary = piImportDryRunResult({
    organizationId: 'organization-1',
    projectName: 'Imported project',
    session: { sessionId: 'pi-session-1', bytes: 100, entries: 3, checksum: 'a'.repeat(64) },
    workspace: {
      payloadPath: '/private/payload.tgz',
      bytes: 200,
      checksum: 'b'.repeat(64),
      kind: 'git_patch',
      summary: {
        trackedFiles: 3,
        untrackedFiles: 1,
        hasStagedChanges: true,
        hasUnstagedChanges: true,
        gitBundleIncluded: true,
      },
      runtime: runtimeFixture,
      cleanup: async () => {},
    },
    environment: {
      payloadPath: '/private/environment.json',
      bytes: 30,
      checksum: 'c'.repeat(64),
      variableCount: 2,
      cleanup: async () => {},
    },
    manifestChecksum: 'd'.repeat(64),
  })
  const serialized = JSON.stringify(summary)

  assert.equal(summary.dryRun, true)
  assert.match(serialized, /"variableCount":2/)
  assert.doesNotMatch(serialized, /payload\.tgz|environment\.json|private/)
  assert.doesNotMatch(serialized, /DATABASE_URL|secret/i)
})

test('requires explicit confirmation for non-interactive and JSON imports', async () => {
  const workspace = {
    payloadPath: '/private/payload.tgz',
    bytes: 200,
    checksum: 'b'.repeat(64),
    kind: 'git_patch' as const,
    summary: {
      trackedFiles: 3,
      untrackedFiles: 1,
      hasStagedChanges: true,
      hasUnstagedChanges: true,
      gitBundleIncluded: true,
    },
    runtime: runtimeFixture,
    cleanup: async () => {},
  }
  const environment = {
    payloadPath: '/private/environment.json',
    bytes: 30,
    checksum: 'c'.repeat(64),
    variableCount: 2,
    cleanup: async () => {},
  }
  await assert.rejects(
    confirmPiImport({ json: true, yes: false, projectName: 'Project', workspace, environment }),
    /JSON imports require --yes/,
  )
  await assert.rejects(
    confirmPiImport({ json: false, yes: false, projectName: 'Project', workspace, environment, interactive: false }),
    /Non-interactive imports require --yes/,
  )
  const prompt: string[] = []
  await confirmPiImport(
    { json: false, yes: false, projectName: 'Project', workspace, environment, interactive: true },
    async () => 'yes\n',
    (value) => prompt.push(value),
  )
  assert.match(prompt.join(''), /2 environment variables/)
  assert.doesNotMatch(prompt.join(''), /payload\.tgz|environment\.json|private/)
})

test('dry-run validates local state and auth without creating a transfer, journal, or upload', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-cli-dry-run-test-'))
  const fixture = await createPiImportFixture(join(root, 'fixture'))
  const configRoot = join(root, 'config')
  const stateRoot = join(root, 'state')
  const calls: Array<{ method: string; path: string }> = []
  const server = createServer((request, response) => {
    calls.push({ method: request.method ?? '', path: request.url ?? '' })
    if (request.method === 'GET' && request.url === '/api/cli/auth/status') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ organizationId: 'organization-1', scope: 'pi_sessions:import', expiresAt: '2026-08-01T00:00:00.000Z', user: { id: 'user-1', email: 'user@example.test', name: 'User' } }))
      return
    }
    response.statusCode = 500
    response.end('unexpected request')
  })
  const originalConfig = process.env.XDG_CONFIG_HOME
  const originalState = process.env.XDG_STATE_HOME
  const originalWrite = process.stdout.write
  const output: string[] = []
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test control plane did not bind.')
    const origin = `http://127.0.0.1:${address.port}`
    process.env.XDG_CONFIG_HOME = configRoot
    process.env.XDG_STATE_HOME = stateRoot
    await mkdir(join(configRoot, 'gobare'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(configRoot, 'gobare', 'config.json'),
      `${JSON.stringify({ server: origin, credentialStorage: 'file' })}\n`,
      { mode: 0o600 },
    )
    await writeFile(
      join(configRoot, 'gobare', 'credentials.json'),
      `${JSON.stringify({ server: origin, token: 'gbr_pat_dry_run_fixture_token_0123456789' })}\n`,
      { mode: 0o600 },
    )
    await chmod(join(configRoot, 'gobare', 'config.json'), 0o600)
    await chmod(join(configRoot, 'gobare', 'credentials.json'), 0o600)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    await runPiImport([
      '--session',
      fixture.session,
      '--name',
      'Dry run fixture',
      '--workspace',
      fixture.workspace,
      '--include-env',
      '--dry-run',
    ])

    assert.deepEqual(calls, [{ method: 'GET', path: '/api/cli/auth/status' }])
    assert.match(output.join(''), /"dryRun":true/)
    await assert.rejects(access(join(stateRoot, 'gobare', 'pi-imports')))
  } finally {
    process.stdout.write = originalWrite
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalConfig
    if (originalState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalState
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
})

test('persists the remote project ID before an upload failure so cleanup can recover it', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-cli-import-journal-test-'))
  const fixture = await createPiImportFixture(join(root, 'fixture'))
  const configRoot = join(root, 'config')
  const stateRoot = join(root, 'state')
  const calls: Array<{ method: string; path: string }> = []
  const server = createServer((request, response) => {
    calls.push({ method: request.method ?? '', path: request.url ?? '' })
    request.resume()
    response.setHeader('content-type', 'application/json')
    if (request.method === 'POST' && request.url === '/api/cli/pi-imports') {
      response.end(JSON.stringify({
        projectId: 'project-created-before-upload',
        projectUrl: 'https://app.gobare.dev/sessions/project-created-before-upload',
        transferId: 'unused-by-client',
        status: 'created',
        bindingState: 'unbound',
        created: true,
      }))
      return
    }
    if (request.method === 'PUT' && request.url?.startsWith('/api/cli/pi-imports/')) {
      response.statusCode = 503
      response.end(JSON.stringify({ error: 'temporary upload outage' }))
      return
    }
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'unexpected request' }))
  })
  const originalConfig = process.env.XDG_CONFIG_HOME
  const originalState = process.env.XDG_STATE_HOME
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test control plane did not bind.')
    const origin = `http://127.0.0.1:${address.port}`
    process.env.XDG_CONFIG_HOME = configRoot
    process.env.XDG_STATE_HOME = stateRoot
    await mkdir(join(configRoot, 'gobare'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(configRoot, 'gobare', 'config.json'),
      `${JSON.stringify({ server: origin, credentialStorage: 'file' })}\n`,
      { mode: 0o600 },
    )
    await writeFile(
      join(configRoot, 'gobare', 'credentials.json'),
      `${JSON.stringify({ server: origin, token: 'gbr_pat_journal_fixture_token_0123456789' })}\n`,
      { mode: 0o600 },
    )
    await chmod(join(configRoot, 'gobare', 'config.json'), 0o600)
    await chmod(join(configRoot, 'gobare', 'credentials.json'), 0o600)

    await assert.rejects(
      runPiImport([
        '--session',
        fixture.session,
        '--name',
        'Journal recovery fixture',
        '--workspace',
        fixture.workspace,
        '--include-env',
        '--json',
        '--yes',
      ]),
      /temporary upload outage/,
    )

    const files = await readdir(join(stateRoot, 'gobare', 'pi-imports'))
    assert.equal(files.length, 1)
    const journal = JSON.parse(
      await readFile(join(stateRoot, 'gobare', 'pi-imports', files[0]!), 'utf8'),
    ) as Record<string, unknown>
    assert.equal(journal.projectId, 'project-created-before-upload')
    assert.equal(typeof journal.transferId, 'string')
    assert.equal(journal.token, undefined)
    assert.deepEqual(calls.map(({ method, path }) => ({ method, path: path.replace(/\/api\/cli\/pi-imports\/[^/]+\/payload\/piSession\/0$/, '/api/cli/pi-imports/:transferId/payload/piSession/0') })), [
      { method: 'POST', path: '/api/cli/pi-imports' },
      { method: 'PUT', path: '/api/cli/pi-imports/:transferId/payload/piSession/0' },
    ])
  } finally {
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalConfig
    if (originalState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalState
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
})

test('resumes the exact journaled transfer without creating a second Gobare project', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-cli-resume-test-'))
  const fixture = await createPiImportFixture(join(root, 'fixture'))
  const configRoot = join(root, 'config')
  const stateRoot = join(root, 'state')
  const calls: Array<{ method: string; path: string }> = []
  let uploadAttempts = 0
  const server = createServer((request, response) => {
    calls.push({ method: request.method ?? '', path: request.url ?? '' })
    request.resume()
    response.setHeader('content-type', 'application/json')
    if (request.method === 'POST' && request.url === '/api/cli/pi-imports') {
      response.end(JSON.stringify({ projectId: 'project-resume', projectUrl: 'https://app.gobare.dev/sessions/project-resume', transferId: 'server-transfer', status: 'created', bindingState: 'unbound', created: true }))
      return
    }
    if (request.method === 'GET' && request.url?.startsWith('/api/cli/pi-imports/')) {
      response.end(JSON.stringify({ transferId: request.url.split('/').at(-1), projectId: 'project-resume', projectUrl: 'https://app.gobare.dev/sessions/project-resume', status: 'failed', compatibility: {}, canContinue: false }))
      return
    }
    if (request.method === 'PUT' && request.url?.includes('/payload/')) {
      uploadAttempts += 1
      if (uploadAttempts === 1) {
        response.statusCode = 503
        response.end(JSON.stringify({ error: 'temporary upload outage' }))
      } else response.end(JSON.stringify({ received: 1, total: 1 }))
      return
    }
    if (request.method === 'POST' && request.url?.endsWith('/payload/complete')) {
      uploadAttempts += 1
      response.end(JSON.stringify({ transferId: 'resumed-transfer', projectId: 'project-resume', status: 'resumed', compatibility: {}, canContinue: false }))
      return
    }
    response.statusCode = 500
    response.end(JSON.stringify({ error: 'unexpected request' }))
  })
  const originalConfig = process.env.XDG_CONFIG_HOME
  const originalState = process.env.XDG_STATE_HOME
  const originalWrite = process.stdout.write
  const output: string[] = []
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test control plane did not bind.')
    const origin = `http://127.0.0.1:${address.port}`
    process.env.XDG_CONFIG_HOME = configRoot
    process.env.XDG_STATE_HOME = stateRoot
    await mkdir(join(configRoot, 'gobare'), { recursive: true, mode: 0o700 })
    await writeFile(join(configRoot, 'gobare', 'config.json'), `${JSON.stringify({ server: origin, credentialStorage: 'file' })}\n`, { mode: 0o600 })
    await writeFile(join(configRoot, 'gobare', 'credentials.json'), `${JSON.stringify({ server: origin, token: 'gbr_pat_resume_fixture_token_0123456789' })}\n`, { mode: 0o600 })
    await assert.rejects(runPiImport(['--session', fixture.session, '--name', 'Resume fixture', '--workspace', fixture.workspace, '--include-env', '--json', '--yes']), /temporary upload outage/)
    const [journalFile] = await readdir(join(stateRoot, 'gobare', 'pi-imports'))
    const journal = JSON.parse(await readFile(join(stateRoot, 'gobare', 'pi-imports', journalFile!), 'utf8')) as { transferId: string }
    process.stdout.write = ((chunk: string | Uint8Array) => { output.push(Buffer.from(chunk).toString('utf8')); return true }) as typeof process.stdout.write
    await runPiImportResume([journal.transferId, '--json', '--yes'])
    const result = JSON.parse(output.join('')) as { projectId?: string; status?: string; resumed?: boolean }
    assert.deepEqual(result, { transferId: journal.transferId, projectId: 'project-resume', projectUrl: 'https://app.gobare.dev/sessions/project-resume', status: 'resumed', resumed: true, next: 'Gobare is restoring your project. Open it to follow progress; connect a model only before your next AI task.' })
    assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/api/cli/pi-imports').length, 1)
    // One failed part plus all payload parts and the finalization request; the exact number of
    // parts is an implementation detail, while retrying the same transfer is the contract.
    assert.ok(uploadAttempts > 1)
  } finally {
    process.stdout.write = originalWrite
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = originalConfig
    if (originalState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalState
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
})
