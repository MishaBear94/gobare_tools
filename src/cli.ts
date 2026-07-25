#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createPiImport,
  cliAuthStatus,
  downloadPiImportCheckpoint,
  downloadPiProjectCheckpoint,
  getPiImport,
  uploadPiImportPayload,
  type PiTransferManifest,
} from './api.js'
import { loadAuthConfig, removeAuthConfig, saveAuthConfig } from './auth-config.js'
import { findPiImportJournalByTransferId, loadPiImportJournal, savePiImportJournal } from './import-journal.js'
import { inspectPiSession, preparePiSession } from './pi-session.js'
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js'
import { prepareEnvironment, type PreparedEnvironment } from './environment.js'
import { resolveLoginToken } from './login-token.js'


function usage(): string {
  return [
    'Usage:',
    '  gobare auth login --token [<token>] [--server <url>]',
    '  gobare auth status',
    '  gobare auth logout',
    '  gobare pi inspect --session <pi-session-id-or-file>',
    '  gobare pi import --session <pi-session-id-or-file> --name <project-name> [--workspace <path>] [--include-env] [--dry-run] [--json --yes]',
    '  gobare pi import resume <transfer-id>',
    '  gobare pi export (--project <project-id> | --transfer <transfer-id>) --output <path> [--force]',
    '',
    'Pi import accepts a stopped local Pi session. It creates a new Gobare project and starts cloud restore automatically.',
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

export function piImportDryRunResult(input: {
  organizationId: string
  projectName: string
  session: { sessionId: string; bytes: number; entries: number; checksum: string }
  workspace: PreparedWorkspace
  environment: PreparedEnvironment | null
  manifestChecksum: string
}): Record<string, unknown> {
  return {
    dryRun: true,
    organizationId: input.organizationId,
    projectName: input.projectName,
    session: input.session,
    workspace: {
      kind: input.workspace.kind,
      bytes: input.workspace.bytes,
      checksum: input.workspace.checksum,
      summary: input.workspace.summary,
    },
    ...(input.environment
      ? {
          environment: {
            variableCount: input.environment.variableCount,
            bytes: input.environment.bytes,
            checksum: input.environment.checksum,
          },
        }
      : { environment: { variableCount: 0 } }),
    manifestChecksum: input.manifestChecksum,
    next: 'Preflight passed. No project, transfer, upload, cloud host, or local retry journal was created.',
  }
}

function readConfirmation(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ''
    process.stdin.setEncoding('utf8')
    process.stdin.once('error', reject)
    process.stdin.once('data', (chunk: string) => {
      value += chunk
      resolve(value)
    })
    process.stdin.resume()
  })
}

function printPiImportResult(
  result: {
    projectId: string
    projectUrl: string
    transferId: string
    status: string
    bindingState: string
  },
  json: boolean,
): void {
  const next = result.status === 'resumed'
    ? 'Gobare is restoring your project. Open it to follow progress; connect a model only before your next AI task.'
    : 'Open the project in Gobare to review the import status.'
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...result, next })}\n`)
    return
  }
  process.stdout.write(
    [
      '',
      'Project created. Cloud restore has started.',
      `Open Gobare: ${result.projectUrl}`,
      '',
      'You can close this terminal now. Gobare restores the workspace and Pi history in the background.',
      'Connect a model only when you are ready to send the next AI task.',
    ].join('\n') + '\n',
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function uploadProgressWriter(): (event: { payload: string; completed: number; total: number }) => void {
  let previous = ''
  return ({ payload, completed, total }) => {
    const message = `Uploading ${payload}: ${completed}/${total} part${total === 1 ? '' : 's'} complete`
    if (message !== previous) process.stderr.write(`${message}\n`)
    previous = message
  }
}

export async function confirmPiImport(
  options: {
    json: boolean
    yes: boolean
    projectName: string
    workspace: PreparedWorkspace
    environment: PreparedEnvironment | null
    interactive?: boolean
  },
  read: () => Promise<string> = readConfirmation,
  write: (value: string) => void = (value) => process.stderr.write(value),
): Promise<void> {
  if (options.json && !options.yes) {
    throw new Error('Non-interactive JSON imports require --yes.')
  }
  if (options.yes) return
  if (!(options.interactive ?? process.stdin.isTTY)) {
    throw new Error('Non-interactive imports require --yes.')
  }
  write(
    `Ready to create "${options.projectName}" (${options.workspace.kind}, ${options.workspace.bytes} bytes, ${options.workspace.summary.untrackedFiles} untracked files${options.environment ? `, ${options.environment.variableCount} environment variables` : ''}). Continue? [y/N] `,
  )
  if (!/^(?:y|yes)\s*$/i.test(await read())) throw new Error('Import cancelled.')
}

export async function runPiImport(args: string[]): Promise<void> {
  const reference = argument(args, '--session')
  const projectName = argument(args, '--name')
  if (!reference) throw new Error('Missing --session.')
  if (!projectName?.trim()) throw new Error('Missing --name.')
  if (projectName.trim().length > 120) throw new Error('Project names are limited to 120 characters.')
  const config = await configuredAuth()
  const dryRun = args.includes('--dry-run')
  const json = args.includes('--json')
  const yes = args.includes('--yes')
  // A dry run still validates the scoped token and organization, but must terminate before any
  // transfer identity, journal, remote project, payload upload, or sandbox side effect exists.
  const authenticated = dryRun ? await cliAuthStatus(config) : undefined
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
        runtime: preparedWorkspace.runtime,
      },
      ...(preparedEnvironment ? { environment: { checksum: preparedEnvironment.checksum, byteLength: preparedEnvironment.bytes } } : {}),
    }
    const manifestChecksum = canonicalManifestChecksum(manifest)
    if (dryRun) {
      process.stdout.write(
        `${JSON.stringify(
          piImportDryRunResult({
            organizationId: authenticated!.organizationId,
            projectName: projectName.trim(),
            session: {
              sessionId: prepared.sessionId,
              bytes: prepared.bytes,
              entries: prepared.entries,
              checksum: prepared.checksum,
            },
            workspace: preparedWorkspace,
            environment: preparedEnvironment,
            manifestChecksum,
          }),
        )}\n`,
      )
      return
    }
    await confirmPiImport({
      json,
      yes,
      projectName: projectName.trim(),
      workspace: preparedWorkspace,
      environment: preparedEnvironment,
    })
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
      manifest,
      createdAt: manifest.createdAt,
      sessionReference: reference,
      workspacePath: resolve(workspacePath),
      includeEnvironment: args.includes('--include-env'),
    })
    if (!json) process.stderr.write('Creating Gobare project...\n')
    const created = await createPiImport(config, {
      transferId,
      idempotencyKey,
      projectName: projectName.trim(),
      manifest,
    })
    // Persist the remote project identity before any payload I/O. If the process or network dies
    // during upload, the retry path and destructive smoke cleanup can still address the exact
    // create-if-absent project instead of leaving an opaque orphan behind.
    await savePiImportJournal({
      server: config.server.replace(/\/$/, ''),
      projectName: projectName.trim(),
      sessionChecksum: prepared.checksum,
      transferId,
      projectId: created.projectId,
      idempotencyKey,
      manifestChecksum,
      manifest,
      createdAt: manifest.createdAt,
      sessionReference: reference,
      workspacePath: resolve(workspacePath),
      includeEnvironment: args.includes('--include-env'),
    })
    const payload = await readFile(prepared.payloadPath)
    const workspacePayload = await readFile(preparedWorkspace.payloadPath)
    const environmentPayload = preparedEnvironment ? await readFile(preparedEnvironment.payloadPath) : undefined
    if (!json) {
      process.stderr.write(
        `Uploading ${formatBytes(payload.byteLength + workspacePayload.byteLength + (environmentPayload?.byteLength ?? 0))} in resumable parts...\n`,
      )
    }
    const uploaded = await uploadPiImportPayload(
      config,
      transferId,
      payload,
      workspacePayload,
      environmentPayload,
      json ? undefined : uploadProgressWriter(),
    )
    if (!json) process.stderr.write('Starting cloud restore...\n')
    printPiImportResult({
      projectId: created.projectId,
      projectUrl: created.projectUrl,
      transferId,
      status: uploaded.status,
      bindingState: created.bindingState,
    }, json)
  } finally {
    await Promise.all([prepared.cleanup(), preparedWorkspace?.cleanup(), preparedEnvironment?.cleanup()])
  }
}

async function runPiExport(args: string[]): Promise<void> {
  const transferId = argument(args, '--transfer')
  const projectId = argument(args, '--project')
  const output = argument(args, '--output')
  if (!transferId && !projectId) throw new Error('Pass --project or --transfer.')
  if (transferId && projectId) throw new Error('Pass either --project or --transfer, not both.')
  if (!output) throw new Error('Missing --output.')
  const destination = resolve(output)
  const bytes = projectId
    ? await downloadPiProjectCheckpoint(await configuredAuth(), projectId)
    : await downloadPiImportCheckpoint(await configuredAuth(), transferId!)
  try {
    // Default `wx` protects an existing local Pi session from accidental replacement. Exported
    // bytes are kept only after the bundled Pi-native validator opens the exact output file.
    await writeFile(destination, bytes, { flag: args.includes('--force') ? 'w' : 'wx', mode: 0o600 })
    const inspected = await inspectPiSession(destination)
    process.stdout.write(`${JSON.stringify({
      ...(projectId ? { projectId } : { transferId }),
      output: destination,
      sessionId: inspected.sessionId,
      checksum: inspected.checksum,
      bytes: inspected.bytes,
    })}\n`)
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function runPiImportResume(args: string[]): Promise<void> {
  const transferId = args[0]
  if (!transferId) throw new Error('Missing transfer ID.')
  const config = await configuredAuth()
  const journal = await findPiImportJournalByTransferId(transferId)
  if (!journal) {
    throw new Error('No local retry journal was found for this transfer. Re-run the original pi import command from the stopped Pi project.')
  }
  if (journal.server !== config.server.replace(/\/$/, '')) {
    throw new Error('This transfer belongs to a different Gobare server. Switch CLI auth before resuming it.')
  }
  if (!journal.sessionReference || !journal.workspacePath) {
    throw new Error('This retry journal predates resumable uploads. Re-run the original pi import command to validate and continue this transfer.')
  }

  const existing = await getPiImport(config, transferId)
  if (existing.status === 'restorable_paused' || existing.status === 'resumed' || existing.status === 'code_only_ready' || existing.status === 'completed') {
    process.stdout.write(`${JSON.stringify({ ...existing, resumed: false, next: existing.status === 'resumed' ? 'Gobare is restoring this project. Open it to follow progress.' : 'This import is already uploaded. Open the project in Gobare to inspect it.' })}\n`)
    return
  }

  const prepared = await preparePiSession(journal.sessionReference)
  let preparedWorkspace: PreparedWorkspace | undefined
  let preparedEnvironment: PreparedEnvironment | null | undefined
  try {
    if (prepared.checksum !== journal.sessionChecksum) {
      throw new Error('The stopped local Pi session no longer matches this retry journal. Re-run pi import with a new project name.')
    }
    preparedWorkspace = await prepareWorkspace(journal.workspacePath)
    preparedEnvironment = await prepareEnvironment(journal.workspacePath, journal.includeEnvironment === true)
    const rebuiltManifest: PiTransferManifest = {
      format: 'gobare-pi-transfer-v1',
      transferId,
      createdAt: journal.createdAt,
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
        runtime: preparedWorkspace.runtime,
      },
      ...(preparedEnvironment ? { environment: { checksum: preparedEnvironment.checksum, byteLength: preparedEnvironment.bytes } } : {}),
    }
    const manifest = journal.manifest ?? rebuiltManifest
    const manifestMatchesLocalPayload =
      manifest.transferId === transferId &&
      manifest.session.checksum === prepared.checksum &&
      manifest.session.byteLength === prepared.bytes &&
      manifest.session.piSessionId === prepared.sessionId &&
      manifest.workspace?.checksum === preparedWorkspace.checksum &&
      manifest.workspace?.byteLength === preparedWorkspace.bytes &&
      manifest.workspace.kind === preparedWorkspace.kind &&
      (manifest.environment?.checksum ?? null) === (preparedEnvironment?.checksum ?? null) &&
      (manifest.environment?.byteLength ?? null) === (preparedEnvironment?.bytes ?? null)
    if (!manifestMatchesLocalPayload || canonicalManifestChecksum(manifest) !== journal.manifestChecksum) {
      throw new Error('The local workspace or environment no longer matches this retry journal. Re-run pi import with a new project name.')
    }
    await confirmPiImport({
      json: args.includes('--json'),
      yes: args.includes('--yes'),
      projectName: journal.projectName,
      workspace: preparedWorkspace,
      environment: preparedEnvironment,
    })
    if (!args.includes('--json')) process.stderr.write('Resuming Gobare upload...\n')
    const uploaded = await uploadPiImportPayload(
      config,
      transferId,
      await readFile(prepared.payloadPath),
      await readFile(preparedWorkspace.payloadPath),
      preparedEnvironment ? await readFile(preparedEnvironment.payloadPath) : undefined,
      args.includes('--json') ? undefined : uploadProgressWriter(),
    )
    await savePiImportJournal({ ...journal, ...(existing.projectId ? { projectId: existing.projectId } : {}) })
    process.stdout.write(`${JSON.stringify({
      transferId,
      ...(existing.projectId ? { projectId: existing.projectId } : {}),
      ...(existing.projectUrl ? { projectUrl: existing.projectUrl } : {}),
      status: uploaded.status,
      resumed: true,
      next: uploaded.status === 'resumed'
        ? 'Gobare is restoring your project. Open it to follow progress; connect a model only before your next AI task.'
        : 'Open the project in Gobare to review the import status.',
    })}\n`)
  } finally {
    await Promise.all([prepared.cleanup(), preparedWorkspace?.cleanup(), preparedEnvironment?.cleanup()])
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (args[0] === 'auth') {
    if (args[1] === 'login') {
      const token = await resolveLoginToken(args.slice(2), process.env.GOBARE_TOKEN)
      if (!token?.startsWith('gbr_pat_')) throw new Error('Pass a Gobare CLI token through stdin (--token), GOBARE_TOKEN, or --token <token>.')
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
      await runPiImportResume(args.slice(3))
      return
    }
    if (args[1] === 'import') {
      await runPiImport(args.slice(2))
      return
    }
    if (args[1] === 'export') {
      await runPiExport(args.slice(2))
      return
    }
    throw new Error('Use pi inspect, pi import, pi import resume, or pi export.')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unable to inspect Pi session.'}\n`)
    process.exitCode = 1
  }
}

// macOS commonly exposes the same temporary package path through both `/var` and `/private/var`.
// Compare real paths so a verified npm-installed CLI actually starts, while test imports remain inert.
function isDirectCliInvocation(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(import.meta.filename)
  } catch {
    return false
  }
}

if (isDirectCliInvocation()) {
  void main()
    .then(async () => {
      // Pi's native session reader can keep optional clipboard worker handles alive on macOS
      // after the session and temporary archive are closed. Flush output, then terminate this
      // one-shot CLI process so a successful import always returns the user's shell promptly.
      await Promise.all([
        new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
        new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
      ])
      process.exit(process.exitCode ?? 0)
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Gobare command failed.'}\n`)
      process.exit(1)
    })
}
