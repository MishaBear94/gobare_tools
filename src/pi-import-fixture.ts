import { execFile } from 'node:child_process'
import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { SessionManager } from '@earendil-works/pi-coding-agent'

const execFileAsync = promisify(execFile)

const usage = `Usage: gobare_tools fixture:pi-import -- --output <empty-directory>`

export interface PiImportFixture {
  format: 'gobare-pi-import-fixture-v1'
  root: string
  workspace: string
  session: string
  sessionId: string
  credentialSession: string
}

const usageTotals = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

async function git(workspace: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', workspace, ...args])
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(`Fixture output already exists: ${path}`)
}

/**
 * Produces a known-safe stopped Pi session and a Git workspace with every portable worktree
 * state that import must preserve. This is test data only: it never reads a user session,
 * process environment, credential file, remote URL or provider configuration.
 */
export async function createPiImportFixture(output: string): Promise<PiImportFixture> {
  const root = resolve(output)
  await assertAbsent(root)
  const workspace = join(root, 'workspace')
  const sessions = join(root, 'pi-sessions')
  try {
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sessions, { recursive: true })])
    await git(workspace, ['init'])
    await git(workspace, ['config', 'user.email', 'pi-import-fixture@example.test'])
    await git(workspace, ['config', 'user.name', 'Gobare Pi fixture'])
    await writeFile(join(workspace, 'README.md'), '# Pi import smoke fixture\n')
    await writeFile(join(workspace, 'src.ts'), "export const state = 'committed'\n")
    // Static runtime fixtures prove that import carries a safe preparation plan, not an implicit
    // npm execution request or a copy of project scripts.
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, scripts: { dev: 'vite --host 0.0.0.0', test: 'node --test' } }))
    await writeFile(join(workspace, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n")
    // Runtime configuration is intentionally ignored by Git and excluded from the workspace
    // archive. The import tests must exercise the separate encrypted environment payload instead.
    await writeFile(join(workspace, '.gitignore'), '.env*\n')
    await git(workspace, ['add', 'README.md', 'src.ts', 'package.json', 'pnpm-lock.yaml', '.gitignore'])
    await git(workspace, ['commit', '-m', 'fixture base'])
    await git(workspace, ['checkout', '-b', 'gobare-import-fixture'])
    await git(workspace, ['remote', 'add', 'origin', 'https://example.invalid/gobare/pi-import-fixture.git'])
    await writeFile(join(workspace, 'local-commit.ts'), "export const commit = 'not-pushed'\n")
    await git(workspace, ['add', 'local-commit.ts'])
    await git(workspace, ['commit', '-m', 'fixture local commit'])

    await writeFile(join(workspace, 'src.ts'), "export const state = 'staged'\n")
    await git(workspace, ['add', 'src.ts'])
    await writeFile(join(workspace, 'README.md'), '# Pi import smoke fixture\n\nunstaged change\n')
    await writeFile(join(workspace, 'untracked.txt'), 'untracked fixture file\n')
    await writeFile(join(workspace, '.env'), 'APP_ORIGIN=https://fixture.invalid\nAPP_RUNTIME_LABEL=fixture-runtime-value\n', {
      mode: 0o600,
    })

    const manager = SessionManager.create(workspace, sessions)
    manager.appendSessionInfo('Gobare Pi import smoke fixture')
    const rootUser = manager.appendMessage({
      role: 'user',
      content: 'Create a small project migration fixture.',
      timestamp: 1,
    })
    // Build a real branch tree through Pi's public API. The first assistant reply is intentionally
    // abandoned; the import must project only the current leaf without rewriting this native tree.
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'This branch was intentionally abandoned.' }],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture-model',
      usage: usageTotals,
      stopReason: 'stop',
      timestamp: 2,
    })
    manager.branch(rootUser)
    manager.appendMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I prepared a portable project fixture.' },
        {
          type: 'toolCall',
          id: 'fixture-write',
          name: 'write',
          arguments: { path: 'src.ts', content: "export const state = 'staged'" },
        },
      ],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture-model',
      usage: usageTotals,
      stopReason: 'toolUse',
      timestamp: 3,
    })
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'fixture-write',
      toolName: 'write',
      content: [{ type: 'text', text: 'Wrote src.ts' }],
      isError: false,
      timestamp: 4,
    })
    manager.appendMessage({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'fixture-error',
          name: 'run',
          arguments: { command: 'exit 1' },
        },
      ],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture-model',
      usage: usageTotals,
      stopReason: 'toolUse',
      timestamp: 5,
    })
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'fixture-error',
      toolName: 'run',
      content: [{ type: 'text', text: 'Command exited with status 1.' }],
      isError: true,
      timestamp: 6,
    })
    const imagePrompt = manager.appendMessage({
      role: 'user',
      content: [
        {
          type: 'image',
          // A fixed, non-sensitive PNG signature is enough to exercise image projection without
          // creating a real screenshot, local asset, or credential-shaped fixture payload.
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          mimeType: 'image/png',
        },
      ],
      timestamp: 7,
    })
    manager.appendCompaction('Earlier fixture work is represented by the current branch.', imagePrompt, 64)
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'The stopped fixture is ready to import.' }],
      api: 'openai-completions',
      provider: 'fixture',
      model: 'fixture-model',
      usage: usageTotals,
      stopReason: 'stop',
      timestamp: 8,
    })
    const session = manager.getSessionFile()
    if (!session) throw new Error('Pi did not persist the stopped fixture session.')
    const opened = SessionManager.open(session, join(root, 'validate-sessions'), workspace)
    if (opened.getSessionId() !== manager.getSessionId()) {
      throw new Error('Pi did not reopen the generated fixture session.')
    }
    // This file is deliberately not a Pi session fixture. It exists solely for negative admission
    // tests, proving that both the local CLI and control plane reject credential-shaped bytes
    // before upload. No actual credential is generated or stored.
    const credentialSession = join(root, 'credential-shaped-negative.jsonl')
    await writeFile(credentialSession, await readFile(session))
    await appendFile(
      credentialSession,
      '{"type":"gobare_fixture_negative","token":"gbr_pat_fixture_not_a_real_credential_0123456789"}\n',
      { mode: 0o600 },
    )

    const fixture: PiImportFixture = {
      format: 'gobare-pi-import-fixture-v1',
      root,
      workspace,
      session,
      sessionId: manager.getSessionId(),
      credentialSession,
    }
    await writeFile(join(root, 'fixture.json'), `${JSON.stringify(fixture)}\n`, { mode: 0o600 })
    return fixture
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  const output = argument(process.argv.slice(2), '--output')
  if (!output) throw new Error(usage)
  const fixture = await createPiImportFixture(output)
  // The parent E2E reads the 0600 fixture manifest directly. Keep terminal output free of local
  // temporary paths and Pi session identifiers so a test run cannot leak machine layout.
  process.stdout.write(`${JSON.stringify({ format: fixture.format, outcome: 'created' })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unable to create fixture.'}\n`)
    process.exitCode = 1
  })
}
