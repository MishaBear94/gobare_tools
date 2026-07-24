import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BLOCKED_CONTROL_PLANE_KEY = /(?:^|_)(?:OPENAI|ANTHROPIC|GOBARE|GITHUB|GITLAB|SSH|AWS|AZURE|GOOGLE|SUPABASE|TINYBIRD|DISCORD|SLACK|POLAR|LEMON)(?:_|$)|(?:API|ACCESS|AUTH|OAUTH|PRIVATE)_?(?:KEY|TOKEN|SECRET)|(?:PASSWORD|CREDENTIAL)/i

export interface PreparedEnvironment {
  payloadPath: string
  bytes: number
  checksum: string
  variableCount: number
  cleanup(): Promise<void>
}

function parseDotenv(source: string, file: string): Array<{ key: string; value: string; isSecret: boolean }> {
  const result: Array<{ key: string; value: string; isSecret: boolean }> = []
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!match) throw new Error(`Unsupported environment syntax in ${file}. Use KEY=value entries.`)
    const key = match[1]!
    let value = match[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (BLOCKED_CONTROL_PLANE_KEY.test(key)) throw new Error(`The environment variable ${key} is a control-plane credential and cannot be imported.`)
    result.push({ key, value, isSecret: true })
  }
  return result
}

/** Explicitly collects app runtime configuration only. It never reads the user's shell environment. */
export async function prepareEnvironment(workspace: string, include: boolean): Promise<PreparedEnvironment | null> {
  const root = resolve(workspace)
  const names = ['.env', '.env.local', ...(process.env.NODE_ENV ? [`.env.${process.env.NODE_ENV}`] : [])]
  const files: string[] = []
  for (const name of names) {
    const path = join(root, name)
    try { await access(path); files.push(path) } catch { /* absent is normal */ }
  }
  if (!files.length) return null
  if (!include) throw new Error('environment_source_incomplete: local .env files were found. Re-run with --include-env to explicitly import application runtime variables, or remove them before importing.')
  const seen = new Map<string, { key: string; value: string; isSecret: boolean }>()
  for (const file of files) for (const variable of parseDotenv(await readFile(file, 'utf8'), file)) seen.set(variable.key, variable)
  const payload = Buffer.from(JSON.stringify({ version: 1, variables: [...seen.values()] }), 'utf8')
  const rootTemp = await mkdtemp(join(tmpdir(), 'gobare-environment-import-'))
  const payloadPath = join(rootTemp, 'environment.json')
  await writeFile(payloadPath, payload, { mode: 0o600 })
  return {
    payloadPath,
    bytes: payload.byteLength,
    checksum: createHash('sha256').update(payload).digest('hex'),
    variableCount: seen.size,
    cleanup: () => rm(rootTemp, { recursive: true, force: true }),
  }
}
