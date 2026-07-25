import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLoginToken } from './login-token.js'

test('prefers a backward-compatible inline CLI token', async () => {
  assert.equal(
    await resolveLoginToken(['--token', 'gbr_pat_inline'], 'gbr_pat_environment'),
    'gbr_pat_inline',
  )
})

test('reads a token from stdin when --token has no value', async () => {
  assert.equal(
    await resolveLoginToken(['--token'], undefined, async () => 'gbr_pat_stdin\n'),
    'gbr_pat_stdin',
  )
})

test('allows GOBARE_TOKEN without requiring a command-line secret', async () => {
  assert.equal(
    await resolveLoginToken([], ' gbr_pat_environment '),
    'gbr_pat_environment',
  )
})

test('does not treat another option as an inline token', async () => {
  assert.equal(
    await resolveLoginToken(['--token', '--server', 'https://app.gobare.dev'], undefined, async () => 'gbr_pat_stdin'),
    'gbr_pat_stdin',
  )
})
