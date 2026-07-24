import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024
// The upload boundary is the complete encrypted archive, not an arbitrary per-file threshold.
// A project can legitimately contain a single generated asset larger than 32MB.
const MAX_FILE_BYTES = MAX_ARCHIVE_BYTES

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export interface PreparedWorkspace {
  payloadPath: string
  bytes: number
  checksum: string
  kind: 'git_patch' | 'snapshot'
  repoIdentity?: string
  baseCommit?: string
  summary: {
    trackedFiles: number
    untrackedFiles: number
    hasStagedChanges: boolean
    hasUnstagedChanges: boolean
    gitBundleIncluded: boolean
  }
  cleanup(): Promise<void>
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isExcluded(relativePath: string): boolean {
  const parts = relativePath.split('/')
  const base = parts.at(-1) ?? ''
  return (
    parts.includes('.git') ||
    parts.includes('.pi') ||
    parts.includes('.ssh') ||
    parts.includes('node_modules') ||
    parts.includes('.venv') ||
    parts.includes('venv') ||
    parts.includes('__pycache__') ||
    parts.includes('.cache') ||
    base === '.env' || base.startsWith('.env.') ||
    /\.(?:pem|p12|pfx|key)$/i.test(base) ||
    /(?:credential|credentials|auth|token|cookie|id_rsa|id_ed25519)/i.test(base)
  )
}

function secretFinding(content: string): string | null {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) return 'private_key'
  if (/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/.test(content)) return 'github_token'
  if (/\bgbr_pat_[A-Za-z0-9_-]{20,}\b/.test(content)) return 'gobare_token'
  if (/\bAKIA[0-9A-Z]{16}\b/.test(content)) return 'aws_access_key'
  return null
}

/** A Git remote is useful recovery metadata, but userinfo may embed a personal access token. */
function sanitizeGitRemote(value: string): string {
  const remote = value.trim()
  if (!remote) return ''
  try {
    const url = new URL(remote)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return remote
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    // SCP-style remotes such as git@github.com:owner/repo.git contain an SSH account name, not a
    // transferable credential. Leave them as-is; they are never evaluated as shell source.
    return remote
  }
}

async function copySafeTree(sourceRoot: string, stageRoot: string): Promise<{ files: number; untrackedCandidates: string[] }> {
  let files = 0
  const candidates: string[] = []
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const source = join(current, entry.name)
      const rel = relative(sourceRoot, source)
      if (!rel || isExcluded(rel)) continue
      if (rel.includes('\n') || rel.includes('\0')) throw new Error(`Unsupported workspace filename: ${rel}`)
      const destination = join(stageRoot, rel)
      const info = await lstat(source)
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true, mode: info.mode })
        await visit(source)
      } else if (info.isSymbolicLink()) {
        const target = await readlink(source)
        const resolved = resolve(dirname(source), target)
        if (isAbsolute(target) || !(resolved === sourceRoot || resolved.startsWith(`${sourceRoot}/`))) {
          throw new Error(`Unsafe symlink cannot be imported: ${rel}`)
        }
        await mkdir(dirname(destination), { recursive: true })
        await symlink(target, destination)
        files += 1
      } else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES) {
          throw new Error(
            `Workspace file exceeds the 500MB archive quota: ${rel} (${formatBytes(info.size)}). Remove it or reduce the project payload before importing.`,
          )
        }
        if (info.size > 0 && info.size <= 1024 * 1024) {
          const finding = secretFinding(await readFile(source, 'utf8').catch(() => ''))
          if (finding) throw new Error(`Secret scanner blocked ${rel} (${finding}). Remove it from the workspace before importing.`)
        }
        await mkdir(dirname(destination), { recursive: true })
        await cp(source, destination, { preserveTimestamps: true, verbatimSymlinks: true })
        files += 1
        candidates.push(rel)
      }
    }
  }
  await visit(sourceRoot)
  return { files, untrackedCandidates: candidates }
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

async function gitAvailable(root: string): Promise<boolean> {
  try {
    if ((await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return false
    // A repository with no first commit has no HEAD/ref graph to bundle. It is still imported as
    // a source snapshot, which preserves the actual files without fabricating Git history.
    await git(root, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

async function writeGitState(root: string, stage: string): Promise<PreparedWorkspace['summary'] & { repoIdentity?: string; baseCommit?: string }> {
  const gitDir = join(stage, '.gobare-import')
  await mkdir(gitDir, { recursive: true })
  const [head, branch, remote, staged, unstaged, untracked] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['branch', '--show-current']),
    git(root, ['remote', 'get-url', 'origin']).catch(() => ''),
    git(root, ['diff', '--cached', '--binary']),
    git(root, ['diff', '--binary']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  const safeRemote = sanitizeGitRemote(remote)
  const bundlePath = join(gitDir, 'repository.bundle')
  await execFileAsync('git', ['-C', root, 'bundle', 'create', bundlePath, '--all'])
  await Promise.all([
    writeFile(join(gitDir, 'staged.patch'), staged, { mode: 0o600 }),
    writeFile(join(gitDir, 'unstaged.patch'), unstaged, { mode: 0o600 }),
    // Scalar metadata avoids relying on Node/Python being installed in the restored sandbox.
    // These files are read as data and never sourced by a shell.
    writeFile(join(gitDir, 'git-head'), `${head.trim()}\n`, { mode: 0o600 }),
    writeFile(join(gitDir, 'git-branch'), `${branch.trim()}\n`, { mode: 0o600 }),
    writeFile(join(gitDir, 'git-origin'), `${safeRemote}\n`, { mode: 0o600 }),
    writeFile(join(gitDir, 'git-state.json'), `${JSON.stringify({ head: head.trim(), branch: branch.trim() || null, origin: safeRemote || null })}\n`, { mode: 0o600 }),
  ])
  return {
    trackedFiles: 0,
    untrackedFiles: untracked.split('\0').filter(Boolean).length,
    hasStagedChanges: Boolean(staged),
    hasUnstagedChanges: Boolean(unstaged),
    gitBundleIncluded: true,
    repoIdentity: safeRemote || undefined,
    baseCommit: head.trim() || undefined,
  }
}

function runtimeManifest(root: string): Record<string, unknown> {
  const candidates = ['.nvmrc', '.node-version', '.python-version', 'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'pyproject.toml', 'poetry.lock', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Cargo.lock', 'Dockerfile', 'docker-compose.yml', 'compose.yml']
  return { format: 'gobare-runtime-manifest-v1', workspaceRoot: '/home/user/workspace', discoveredFiles: candidates }
}

/**
 * Captures only portable project state. Runtime dependencies, local home state, credentials, and
 * running processes are intentionally outside this archive and must never be claimed migrated.
 */
export async function prepareWorkspace(workspace: string): Promise<PreparedWorkspace> {
  const root = resolve(workspace)
  if (!(await stat(root)).isDirectory()) throw new Error('The workspace path is not a directory.')
  const temp = await mkdtemp(join(tmpdir(), 'gobare-workspace-import-'))
  const stage = join(temp, 'workspace')
  const archive = join(temp, 'workspace.tgz')
  try {
    await mkdir(stage)
    const copied = await copySafeTree(root, stage)
    const isGit = await gitAvailable(root)
    const gitState = isGit
      ? await writeGitState(root, stage)
      : { trackedFiles: copied.files, untrackedFiles: copied.files, hasStagedChanges: false, hasUnstagedChanges: false, gitBundleIncluded: false }
    const importDir = join(stage, '.gobare-import')
    await mkdir(importDir, { recursive: true })
    await writeFile(join(importDir, 'runtime-manifest.json'), `${JSON.stringify(runtimeManifest(root), null, 2)}\n`, { mode: 0o600 })
    await execFileAsync('tar', ['-czf', archive, '-C', stage, '.'], { maxBuffer: 1024 * 1024 })
    const archiveStat = await stat(archive)
    if (archiveStat.size > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `Workspace archive exceeds the 500MB import limit (${formatBytes(archiveStat.size)}). Excluded paths are listed in the import policy; remove large generated artifacts and retry.`,
      )
    }
    const bytes = await readFile(archive)
    return {
      payloadPath: archive,
      bytes: bytes.byteLength,
      checksum: checksum(bytes),
      kind: isGit ? 'git_patch' : 'snapshot',
      ...(gitState.repoIdentity ? { repoIdentity: gitState.repoIdentity } : {}),
      ...(gitState.baseCommit ? { baseCommit: gitState.baseCommit } : {}),
      summary: { ...gitState, trackedFiles: copied.files },
      cleanup: () => rm(temp, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}
