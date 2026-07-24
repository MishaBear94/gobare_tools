import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const KEYCHAIN_SERVICE = 'dev.gobare.cli'

export interface CliAuthConfig {
  server: string
  token: string
}

type StoredAuthConfig = {
  server: string
  credentialStorage: 'system' | 'file'
}

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gobare')
}

function configPath(): string {
  return join(configDir(), 'config.json')
}

function credentialPath(): string {
  return join(configDir(), 'credentials.json')
}

function normalizedServer(server: string): string {
  return new URL(server).origin
}

async function runWithStdin(command: string, args: string[], stdin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited ${code}`)))
    child.stdin.end(`${stdin}\n`)
  })
}

async function systemCredentialGet(server: string): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', server, '-w'])
      return stdout.trim() || null
    }
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'server', server])
      return stdout.trim() || null
    }
  } catch {
    return null
  }
  return null
}

async function systemCredentialSave(server: string, token: string): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      // `security` is executed directly, never through a shell or the user's command history.
      await execFileAsync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', server, '-w', token])
      return true
    }
    if (process.platform === 'linux') {
      await runWithStdin('secret-tool', ['store', '--label=Gobare CLI', 'service', KEYCHAIN_SERVICE, 'server', server], token)
      return true
    }
  } catch {
    return false
  }
  return false
}

async function systemCredentialRemove(server: string): Promise<void> {
  try {
    if (process.platform === 'darwin') await execFileAsync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', server])
    if (process.platform === 'linux') await execFileAsync('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'server', server])
  } catch {
    // Logout must still remove Gobare's local metadata even when an OS keychain entry is absent.
  }
}

async function writeStoredConfig(value: StoredAuthConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await writeFile(configPath(), `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await chmod(configPath(), 0o600)
}

async function readStoredConfig(): Promise<StoredAuthConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<StoredAuthConfig>
    if (typeof parsed.server !== 'string') return null
    if (parsed.credentialStorage !== 'system' && parsed.credentialStorage !== 'file') return null
    return { server: normalizedServer(parsed.server), credentialStorage: parsed.credentialStorage }
  } catch {
    return null
  }
}

async function readFileCredential(server: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialPath(), 'utf8')) as { server?: unknown; token?: unknown }
    return parsed.server === server && typeof parsed.token === 'string' && parsed.token ? parsed.token : null
  } catch {
    return null
  }
}

export async function loadAuthConfig(): Promise<CliAuthConfig | null> {
  const stored = await readStoredConfig()
  const server = stored?.server ?? (process.env.GOBARE_SERVER ? normalizedServer(process.env.GOBARE_SERVER) : 'https://app.gobare.dev')
  const environmentToken = process.env.GOBARE_TOKEN
  if (environmentToken) return { server, token: environmentToken }
  if (!stored) return null
  const token = stored.credentialStorage === 'system'
    ? await systemCredentialGet(server)
    : await readFileCredential(server)
  return token ? { server, token } : null
}

/**
 * System keychain is mandatory by default. File fallback is deliberately opt-in because it is a
 * lower security mode even though its directory/file permissions are restricted.
 */
export async function saveAuthConfig(config: CliAuthConfig, options: { allowFileCredentials?: boolean } = {}): Promise<void> {
  const server = normalizedServer(config.server)
  if (await systemCredentialSave(server, config.token)) {
    await rm(credentialPath(), { force: true })
    await writeStoredConfig({ server, credentialStorage: 'system' })
    return
  }
  if (!options.allowFileCredentials) {
    throw new Error('System credential storage is unavailable. Retry with --allow-file-credentials only if you accept an encrypted-filesystem protected local file fallback.')
  }
  await mkdir(configDir(), { recursive: true, mode: 0o700 })
  await writeFile(credentialPath(), `${JSON.stringify({ server, token: config.token })}\n`, { mode: 0o600 })
  await chmod(credentialPath(), 0o600)
  await writeStoredConfig({ server, credentialStorage: 'file' })
}

export async function removeAuthConfig(): Promise<void> {
  const stored = await readStoredConfig()
  if (stored?.credentialStorage === 'system') await systemCredentialRemove(stored.server)
  await Promise.all([rm(configPath(), { force: true }), rm(credentialPath(), { force: true })])
}
