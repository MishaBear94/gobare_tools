#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createPiImport, cliAuthStatus, getPiImport, uploadPiImportPayload, type PiTransferManifest } from './api.js'
import { loadAuthConfig, removeAuthConfig, saveAuthConfig } from './auth-config.js'
import { loadPiImportJournal, savePiImportJournal } from './import-journal.js'
import { inspectPiSession, preparePiSession } from './pi-session.js'
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js'
import { prepareEnvironment, type PreparedEnvironment } from './environment.js'


function usage(): string {
  return [
    'Usage:',
    '  gobare auth login --token <token> [--server <url>]',
    '  gobare auth status',
    '  gobare auth logout',
    '  gobare pi inspect --session <pi-session-id-or-file>',
    '  gobare pi import --session <pi-session-id-or-file> --name <project-name> [--workspace <path>] [--include-env]',
    '  gobare pi import resume <transfer-id>',
    '',
    'Pi import accepts a stopped local Pi session. It creates a new Gobare project and does not start a cloud host.',
  ].join('\n')
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function canonicalManifestChecksum(manifest: PiTransferManifest): string {
  // Every current field is scalar/object and emitted in a stable order by buildManifest. This
  // journal digest is only a local retry guard; the server independently calculates its digest.
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

function localPiMetadata(): { package: string; packageVersion: string; sourceCommit: string; sessionFormatVersion: string } {
  // The CLI's bundled native validator is pinned in package.json. The local session JSONL is
  // deliberately treated as opaque and version metadata remains diagnostic at the server.
  const version = '0.81.1'
  return {
    package: '@earendil-works/pi-coding-agent',
    packageVersion: version,
    // This is diagnostic only. Gobare intentionally makes native cloud open the compatibility
    // authority rather than rejecting a local Pi package version/source revision at intake.
    sourceCommit: 'unknown',
    sessionFormatVersion: `pi-native-jsonl-${version}`,
  }
}

async function configuredAuth() {
  const config = await loadAuthConfig()
  if (!config) throw new Error('No Gobare CLI token is configured. Run gobare auth login first.')
  return config
}

async function runPiImport(args: string[]): Promise<void> {
  const reference = argument(args, '--session')
  const projectName = argument(args, '--name')
  if (!reference) throw new Error('Missing --session.')
  if (!projectName?.trim()) throw new Error('Missing --name.')
  if (projectName.trim().length > 120) throw new Error('Project names are limited to 120 characters.')
  const config = await configuredAuth()
  const workspacePath = argument(args, '--workspace') ?? process.cwd()
  const prepared = await preparePiSession(reference)
  let preparedWorkspace: PreparedWorkspace | undefined
  let preparedEnvironment: PreparedEnvironment | null | undefined
  try {
    preparedWorkspace = await prepareWorkspace(workspacePath)
    preparedEnvironment = await prepareEnvironment(workspacePath, args.includes('--include-env'))
    const existingJournal = await loadPiImportJournal(config.server, prepared.checksum, projectName.trim())
    const transferId = existingJournal?.transferId ?? randomUUID()
    const manifest: PiTransferManifest = {
      format: 'gobare-pi-transfer-v1',
      transferId,
      createdAt: existingJournal?.createdAt ?? new Date().toISOString(),
      safeBoundary: 'terminal',
      sourcePlatform: 'local_pi',
      pi: localPiMetadata(),
      session: {
        checksum: prepared.checksum,
        byteLength: prepared.bytes,
        piSessionId: prepared.sessionId,
      },
      workspace: {
        checksum: preparedWorkspace.checksum,
        byteLength: preparedWorkspace.bytes,
        kind: preparedWorkspace.kind,
        ...(preparedWorkspace.repoIdentity ? { repoIdentity: preparedWorkspace.repoIdentity } : {}),
        ...(preparedWorkspace.baseCommit ? { baseCommit: preparedWorkspace.baseCommit } : {}),
      },
      ...(preparedEnvironment ? { environment: { checksum: preparedEnvironment.checksum, byteLength: preparedEnvironment.bytes } } : {}),
    }
    const manifestChecksum = canonicalManifestChecksum(manifest)
    const idempotencyKey = existingJournal?.idempotencyKey ?? randomUUID()
    if (existingJournal && existingJournal.manifestChecksum !== manifestChecksum) {
      throw new Error('The saved import retry does not match this local Pi session. Choose a new project name.')
    }
    await savePiImportJournal({
      server: config.server.replace(/\/$/, ''),
      projectName: projectName.trim(),
      sessionChecksum: prepared.checksum,
      transferId,
      idempotencyKey,
      manifestChecksum,
      createdAt: manifest.createdAt,
    })
    const created = await createPiImport(config, {
      transferId,
      idempotencyKey,
      projectName: projectName.trim(),
      manifest,
    })
    const payload = await readFile(prepared.payloadPath)
    const workspacePayload = await readFile(preparedWorkspace.payloadPath)
    const environmentPayload = preparedEnvironment ? await readFile(preparedEnvironment.payloadPath) : undefined
    const uploaded = await uploadPiImportPayload(config, transferId, payload, workspacePayload, environmentPayload)
    process.stdout.write(`${JSON.stringify({
      projectId: created.projectId,
      projectUrl: created.projectUrl,
      transferId,
      status: uploaded.status,
      bindingState: created.bindingState,
      next: uploaded.status === 'restorable_paused'
        ? 'Open the project in Gobare and choose Restore project. Connect a model only before your next AI task.'
        : 'Open the project in Gobare to review the import status.',
    })}\n`)
  } finally {
    await Promise.all([prepared.cleanup(), preparedWorkspace?.cleanup(), preparedEnvironment?.cleanup()])
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === 'auth') {
    if (args[1] === 'login') {
      const token = argument(args, '--token') ?? process.env.GOBARE_TOKEN
      if (!token?.startsWith('gbr_pat_')) throw new Error('Pass a Gobare CLI token with --token or GOBARE_TOKEN.')
      const server = argument(args, '--server') ?? 'https://app.gobare.dev'
      const config = { server, token }
      const status = await cliAuthStatus(config)
      await saveAuthConfig(config, { allowFileCredentials: args.includes('--allow-file-credentials') })
      process.stdout.write(`Authenticated to ${new URL(server).host} for organization ${status.organizationId}.\n`)
      return
    }
    if (args[1] === 'status') {
      const config = await loadAuthConfig()
      if (!config) throw new Error('No Gobare CLI token is configured.')
      const status = await cliAuthStatus(config)
      process.stdout.write(`${JSON.stringify({ server: config.server, organizationId: status.organizationId, scope: status.scope, expiresAt: status.expiresAt })}\n`)
      return
    }
    if (args[1] === 'logout') {
      await removeAuthConfig()
      process.stdout.write('Removed the local Gobare CLI token.\n')
      return
    }
    throw new Error('Use auth login, auth status, or auth logout.')
  }
  if (args[0] !== 'pi') {
    process.stderr.write(`${usage()}\n`)
    process.exitCode = 2
    return
  }
  try {
    if (args[1] === 'inspect') {
      const reference = argument(args, '--session')
      if (!reference) throw new Error('Missing --session.')
      const inspected = await inspectPiSession(reference)
      process.stdout.write(
        `${JSON.stringify({
          sessionId: inspected.sessionId,
          bytes: inspected.bytes,
          entries: inspected.entries,
          leafId: inspected.leafId,
          ...(inspected.sessionName ? { sessionName: inspected.sessionName } : {}),
        })}\n`,
      )
      return
    }
    if (args[1] === 'import' && args[2] === 'resume') {
      const transferId = args[3]
      if (!transferId) throw new Error('Missing transfer ID.')
      const status = await getPiImport(await configuredAuth(), transferId)
      process.stdout.write(`${JSON.stringify(status)}\n`)
      return
    }
    if (args[1] === 'import') {
      await runPiImport(args.slice(2))
      return
    }
    throw new Error('Use pi inspect, pi import, or pi import resume.')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unable to inspect Pi session.'}\n`)
    process.exitCode = 1
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Gobare command failed.'}\n`)
  process.exitCode = 1
})
