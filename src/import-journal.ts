import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PiImportJournalEntry {
  server: string
  projectName: string
  sessionChecksum: string
  transferId: string
  idempotencyKey: string
  manifestChecksum: string
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

export async function savePiImportJournal(entry: PiImportJournalEntry): Promise<void> {
  const dir = journalDir()
  const path = journalPath(entry.server, entry.sessionChecksum, entry.projectName)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}
