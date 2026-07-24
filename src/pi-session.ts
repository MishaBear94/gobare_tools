import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface InspectedPiSession {
  sourcePath: string
  sessionId: string
  sourceCwd: string
  bytes: number
  checksum: string
  entries: number
  leafId: string | null
  sessionName?: string
}

export interface PreparedPiSession extends InspectedPiSession {
  /** A private immutable copy for upload. It is never the original Pi JSONL. */
  payloadPath: string
  cleanup(): Promise<void>
}

function sessionRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'sessions')
}

async function findSessionFiles(root: string, id: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const candidate = join(root, entry.name)
    if (entry.isDirectory()) results.push(...(await findSessionFiles(candidate, id)))
    else if (entry.isFile() && entry.name.endsWith(`_${id}.jsonl`)) results.push(candidate)
  }
  return results
}

export async function resolvePiSession(reference: string): Promise<string> {
  const direct = resolve(reference)
  try {
    await access(direct)
    return direct
  } catch {
    // A full session ID is unambiguous. Partial IDs are deliberately unsupported so an import
    // never selects a different local conversation than the user intended.
    if (!SESSION_ID.test(reference)) throw new Error('Use an exact Pi session UUID or a session file path.')
  }

  const matches = await findSessionFiles(sessionRoot(), reference)
  if (matches.length === 0) throw new Error('The Pi session was not found in the local session store.')
  if (matches.length > 1) throw new Error('More than one local Pi session matches this ID.')
  return matches[0]!
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Imports only stopped sessions. The copy is validated by Pi's own SessionManager and is never
 * parsed or rewritten by this client.
 */
/**
 * Copies and validates an already-stopped Pi session. Keeping the upload source in this private
 * temporary directory makes the byte digest sent to Gobare identical to the bytes uploaded later.
 */
export async function preparePiSession(reference: string): Promise<PreparedPiSession> {
  const sourcePath = await resolvePiSession(reference)
  const source = await stat(sourcePath)
  if (!source.isFile() || source.size === 0) throw new Error('The Pi session file is empty or unavailable.')

  const root = await mkdtemp(join(tmpdir(), 'gobare-pi-inspect-'))
  const copied = join(root, basename(sourcePath))
  const runtimeDir = join(root, 'runtime')
  const workspaceDir = join(root, 'workspace')
  try {
    await cp(sourcePath, copied)
    const bytes = await readFile(copied)
    await Promise.all([mkdir(runtimeDir), mkdir(workspaceDir)])
    const manager = SessionManager.open(copied, runtimeDir, workspaceDir)
    const header = manager.getHeader()
    if (!header || !manager.getSessionId()) throw new Error('Pi could not identify this native session.')
    return {
      sourcePath,
      sessionId: manager.getSessionId(),
      sourceCwd: header.cwd,
      bytes: bytes.byteLength,
      checksum: sha256(bytes),
      entries: manager.getEntries().length,
      leafId: manager.getLeafId(),
      ...(manager.getSessionName() ? { sessionName: manager.getSessionName() } : {}),
      payloadPath: copied,
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export async function inspectPiSession(reference: string): Promise<InspectedPiSession> {
  const prepared = await preparePiSession(reference)
  try {
    const { payloadPath: _payloadPath, cleanup: _cleanup, ...inspected } = prepared
    return inspected
  } finally {
    await prepared.cleanup()
  }
}
