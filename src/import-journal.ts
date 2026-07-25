import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PiTransferManifest } from './api.js'

export interface PiImportJournalEntry {
  server: string
  projectName: string
  sessionChecksum: string
  transferId: string
  /**
   * Written only after the control plane atomically creates the target project. It lets an
   * interrupted caller clean up its own remote project before transfer cleanup; no credential or
   * payload content belongs in this retry journal.
   */
  projectId?: string
  /** Local-only inputs required to resume the exact interrupted upload. */
  sessionReference?: string
  workspacePath?: string
  includeEnvironment?: boolean
  idempotencyKey: string
  manifestChecksum: string
  /** Safe envelope baseline from the initial create request; never contains payload or credentials. */
  manifest?: PiTransferManifest
  createdAt: string
}

function journalDir(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'gobare', 'pi-imports')
}

function canonicalName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function journalPath(server: string, checksum: string, name: string): string {
  const identity = createHash('sha256').update(`${server.replace(/\/$/, '')}\n${checksum}\n${canonicalName(name)}`).digest('hex')
  return join(journalDir(), `${identity}.json`)
}

export async function loadPiImportJournal(server: string, checksum: string, projectName: string): Promise<PiImportJournalEntry | null> {
  try {
    const path = journalPath(server, checksum, projectName)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PiImportJournalEntry>
    if (
      parsed.server === server.replace(/\/$/, '') &&
      parsed.projectName === projectName &&
      parsed.sessionChecksum === checksum &&
      typeof parsed.transferId === 'string' &&
      typeof parsed.idempotencyKey === 'string' &&
      typeof parsed.manifestChecksum === 'string'
    ) return parsed as PiImportJournalEntry
  } catch {
    // A missing/corrupt journal is not a reason to scan arbitrary local Pi state. A new import is
    // safe while the server still enforces its organization/name uniqueness boundary.
  }
  return null
}

/**
 * Resolves only a previously written Gobare retry journal. It never scans Pi session storage or
 * guesses a project from its name, which keeps `pi import resume` bound to one known transfer.
 */
export async function findPiImportJournalByTransferId(
  transferId: string,
): Promise<PiImportJournalEntry | null> {
  try {
    const files = await readdir(journalDir())
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const parsed = JSON.parse(await readFile(join(journalDir(), file), 'utf8')) as Partial<PiImportJournalEntry>
      if (
        parsed.transferId === transferId &&
        typeof parsed.server === 'string' &&
        typeof parsed.projectName === 'string' &&
        typeof parsed.sessionChecksum === 'string' &&
        typeof parsed.idempotencyKey === 'string' &&
        typeof parsed.manifestChecksum === 'string' &&
        typeof parsed.createdAt === 'string'
      ) return parsed as PiImportJournalEntry
    }
  } catch {
    // A missing/corrupt local retry journal is intentionally indistinguishable from no journal.
  }
  return null
}

export async function savePiImportJournal(entry: PiImportJournalEntry): Promise<void> {
  const dir = journalDir()
  const path = journalPath(entry.server, entry.sessionChecksum, entry.projectName)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}
