import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createPiImportFixture } from './pi-import-fixture.js'

const execFileAsync = promisify(execFile)

test('builds a stopped native Pi session and Git worktree fixture without credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gobare-pi-import-fixture-test-'))
  const output = join(root, 'fixture')
  try {
    const fixture = await createPiImportFixture(output)
    const session = SessionManager.open(
      fixture.session,
      join(root, 'validate-sessions'),
      fixture.workspace,
    )
    const [{ stdout: status }, { stdout: branch }, { stdout: commits }] = await Promise.all([
      execFileAsync('git', ['-C', fixture.workspace, 'status', '--porcelain']),
      execFileAsync('git', ['-C', fixture.workspace, 'branch', '--show-current']),
      execFileAsync('git', ['-C', fixture.workspace, 'rev-list', '--count', 'HEAD']),
    ])
    const serialized = await readFile(join(fixture.root, 'fixture.json'), 'utf8')
    const negative = await readFile(fixture.credentialSession, 'utf8')

    assert.equal(session.getSessionId(), fixture.sessionId)
    assert.ok(session.getEntries().length >= 10)
    const branchPoint = session
      .getEntries()
      .find(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'user' &&
          entry.message.content === 'Create a small project migration fixture.',
      )
    assert.ok(branchPoint)
    assert.equal(session.getChildren(branchPoint.id).length, 2)
    assert.match(JSON.stringify(session.getBranch()), /Earlier fixture work is represented/)
    assert.match(JSON.stringify(session.getBranch()), /fixture-error/)
    assert.match(JSON.stringify(session.getBranch()), /iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/)
    assert.doesNotMatch(JSON.stringify(session.getBranch()), /intentionally abandoned/)
    assert.match(status, /M  src\.ts/)
    assert.match(status, / M README\.md/)
    assert.match(status, /\?\? untracked\.txt/)
    assert.equal(branch.trim(), 'gobare-import-fixture')
    assert.equal(Number(commits.trim()), 2)
    assert.match(negative, /gbr_pat_fixture_not_a_real_credential/)
    assert.doesNotMatch(await readFile(fixture.session, 'utf8'), /gbr_pat_fixture_not_a_real_credential/)
    assert.doesNotMatch(serialized, /gbr_pat_|sk-|Bearer\s/i)
    await assert.rejects(createPiImportFixture(output), /Fixture output already exists/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
