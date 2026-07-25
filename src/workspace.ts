import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
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
  runtime: RuntimeManifest
  cleanup(): Promise<void>
}

export type RuntimePrepareStep = {
  id: 'node_pnpm_install' | 'node_npm_ci' | 'node_yarn_install' | 'python_poetry_install' | 'go_mod_download' | 'rust_cargo_fetch'
  category: 'dependency_install'
  command: string
  requiresApproval: true
}

/**
 * This is intentionally a small, non-sensitive statement of what was actually found in the
 * workspace. It is not a copy of package metadata, shell state, dependency cache or command
 * history. Every suggested operation still requires a separate user approval after restore.
 */
export interface RuntimeManifest {
  format: 'gobare-runtime-manifest-v2'
  workspaceRoot: '/home/user/workspace'
  discoveredFiles: string[]
  declaredScripts: Array<'dev' | 'start' | 'test'>
  prepare: RuntimePrepareStep[]
  attention: Array<'node_lockfile_missing' | 'python_lockfile_missing' | 'rust_lockfile_missing' | 'container_build_requires_approval'>
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

/** Writes a distinct untracked overlay so Git checkout can safely replace tracked source files. */
async function copyUntrackedOverlay(sourceRoot: string, destinationRoot: string, paths: string[]): Promise<void> {
  await mkdir(destinationRoot, { recursive: true })
  for (const rel of paths) {
    const source = join(sourceRoot, rel)
    const destination = join(destinationRoot, rel)
    const info = await lstat(source)
    await mkdir(dirname(destination), { recursive: true })
    if (info.isSymbolicLink()) {
      await symlink(await readlink(source), destination)
      continue
    }
    if (!info.isFile()) throw new Error(`Unsupported untracked workspace entry: ${rel}`)
    await cp(source, destination, { preserveTimestamps: true, verbatimSymlinks: true })
  }
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
  const untrackedPaths = untracked
    .split('\0')
    .filter(Boolean)
    .filter((path) => !isExcluded(path))
  for (const path of untrackedPaths) {
    if (path.includes('\n') || path.includes('\0')) throw new Error(`Unsupported workspace filename: ${path}`)
  }
  const bundlePath = join(gitDir, 'repository.bundle')
  const untrackedOverlay = join(gitDir, 'untracked-overlay')
  await execFileAsync('git', ['-C', root, 'bundle', 'create', bundlePath, '--all'])
  await copyUntrackedOverlay(stage, untrackedOverlay, untrackedPaths)
  await normalizeArchiveTimes(untrackedOverlay)
  await createDeterministicArchive(join(gitDir, 'untracked.tgz'), untrackedOverlay)
  await rm(untrackedOverlay, { recursive: true, force: true })
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
    untrackedFiles: untrackedPaths.length,
    hasStagedChanges: Boolean(staged),
    hasUnstagedChanges: Boolean(unstaged),
    gitBundleIncluded: true,
    repoIdentity: safeRemote || undefined,
    baseCommit: head.trim() || undefined,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function declaredPackageScripts(root: string): Promise<Array<'dev' | 'start' | 'test'>> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: unknown }
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return []
    const scripts = parsed.scripts as Record<string, unknown>
    return (['dev', 'start', 'test'] as const).filter((name) => typeof scripts[name] === 'string')
  } catch {
    // A malformed package.json is a project problem, not a reason to make a claim about its
    // runtime. The restored workspace remains usable and the Console will show no Node plan.
    return []
  }
}

async function runtimeManifest(root: string): Promise<RuntimeManifest> {
  const candidates = [
    '.nvmrc', '.node-version', '.python-version', 'package.json', 'pnpm-lock.yaml', 'package-lock.json',
    'yarn.lock', 'pyproject.toml', 'poetry.lock', 'requirements.txt', 'go.mod', 'go.sum', 'Cargo.toml',
    'Cargo.lock', 'Dockerfile', 'docker-compose.yml', 'compose.yml',
  ]
  const discoveredFiles = (await Promise.all(candidates.map(async (file) => ((await exists(join(root, file))) ? file : null)))).filter(
    (file): file is string => Boolean(file),
  )
  const found = new Set(discoveredFiles)
  const prepare: RuntimePrepareStep[] = []
  const attention: RuntimeManifest['attention'] = []
  if (found.has('pnpm-lock.yaml')) prepare.push({ id: 'node_pnpm_install', category: 'dependency_install', command: 'pnpm install --frozen-lockfile --ignore-scripts', requiresApproval: true })
  else if (found.has('package-lock.json')) prepare.push({ id: 'node_npm_ci', category: 'dependency_install', command: 'npm ci --ignore-scripts', requiresApproval: true })
  else if (found.has('yarn.lock')) prepare.push({ id: 'node_yarn_install', category: 'dependency_install', command: 'yarn install --frozen-lockfile --ignore-scripts', requiresApproval: true })
  else if (found.has('package.json')) attention.push('node_lockfile_missing')

  if (found.has('pyproject.toml') && found.has('poetry.lock')) prepare.push({ id: 'python_poetry_install', category: 'dependency_install', command: 'poetry install --sync --no-root', requiresApproval: true })
  else if (found.has('pyproject.toml') || found.has('requirements.txt')) attention.push('python_lockfile_missing')

  if (found.has('go.mod') && found.has('go.sum')) prepare.push({ id: 'go_mod_download', category: 'dependency_install', command: 'go mod download', requiresApproval: true })
  if (found.has('Cargo.toml') && found.has('Cargo.lock')) prepare.push({ id: 'rust_cargo_fetch', category: 'dependency_install', command: 'cargo fetch --locked', requiresApproval: true })
  else if (found.has('Cargo.toml')) attention.push('rust_lockfile_missing')
  if (found.has('Dockerfile') || found.has('docker-compose.yml') || found.has('compose.yml')) attention.push('container_build_requires_approval')

  return {
    format: 'gobare-runtime-manifest-v2',
    workspaceRoot: '/home/user/workspace',
    discoveredFiles,
    declaredScripts: await declaredPackageScripts(root),
    prepare,
    attention,
  }
}

async function createDeterministicArchive(output: string, cwd: string): Promise<void> {
  const tarPath = `${output}.tar`
  await execFileAsync('tar', ['-cf', tarPath, '-C', cwd, '.'])
  await execFileAsync('gzip', ['-n', tarPath])
  await rename(`${tarPath}.gz`, output)
}

/** Tar records filesystem mtimes. Normalize generated staging metadata so an unchanged project
 * produces the same resumable archive on a later CLI invocation. Symlink timestamps are skipped. */
async function normalizeArchiveTimes(root: string): Promise<void> {
  const epoch = new Date(0)
  async function visit(path: string): Promise<void> {
    const info = await lstat(path)
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry))
      await utimes(path, epoch, epoch)
    } else if (info.isFile()) {
      await utimes(path, epoch, epoch)
    }
  }
  await visit(root)
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
    const runtime = await runtimeManifest(root)
    await writeFile(join(importDir, 'runtime-manifest.json'), `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 })
    await normalizeArchiveTimes(stage)
    await createDeterministicArchive(archive, stage)
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
      runtime,
      cleanup: () => rm(temp, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}
