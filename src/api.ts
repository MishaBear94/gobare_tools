import type { CliAuthConfig } from './auth-config.js'
import type { RuntimeManifest } from './workspace.js'

export interface PiTransferManifest {
  format: 'gobare-pi-transfer-v1'
  transferId: string
  createdAt: string
  safeBoundary: 'paused' | 'terminal'
  sourcePlatform: 'local_pi'
  pi: { package: string; packageVersion: string; sourceCommit: string; sessionFormatVersion: string }
  session: { checksum: string; byteLength: number; piSessionId: string }
  workspace?: {
    checksum: string
    byteLength: number
    kind: 'git_patch' | 'snapshot'
    repoIdentity?: string
    baseCommit?: string
    runtime?: RuntimeManifest
  }
  environment?: { checksum: string; byteLength: number }
}

export interface CreatedPiImport {
  projectId: string
  projectUrl: string
  transferId: string
  status: string
  bindingState: string
  created: boolean
}

export interface PiImportStatus {
  transferId: string
  projectId?: string
  projectUrl?: string
  status: string
  compatibility: Record<string, unknown>
  canContinue: boolean
}

export interface CliAuthStatus {
  organizationId: string
  scope: string
  expiresAt: string
  user: { id: string; email: string | null; name: string | null }
}

const NETWORK_ATTEMPTS = 3

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/**
 * A CLI import has idempotency keys and resumable payloads, so a short retry is safe when no
 * HTTP response was received at all. Deliberately do not retry HTTP failures: those carry a
 * precise server-side policy or validation result that the user needs to see immediately.
 */
async function fetchGobare(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(url, init)
    } catch (error) {
      lastError = error
      if (attempt < NETWORK_ATTEMPTS) await waitForRetry(attempt * 300)
    }
  }
  const detail = lastError instanceof Error && lastError.message ? ` (${lastError.message})` : ''
  throw new Error(
    `Gobare could not reach ${new URL(url).host} after ${NETWORK_ATTEMPTS} attempts${detail}. ` +
      'Check your network, then run "gobare pi import resume <transfer-id>" to continue the same import.',
  )
}

export async function cliAuthStatus(config: CliAuthConfig): Promise<CliAuthStatus> {
  const response = await fetchGobare(`${config.server.replace(/\/$/, '')}/api/cli/auth/status`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
  })
  const payload = (await response.json().catch(() => null)) as { error?: string } | CliAuthStatus | null
  if (!response.ok) throw new Error(payload && 'error' in payload ? payload.error : 'Gobare CLI authentication failed.')
  return payload as CliAuthStatus
}

async function apiRequest<T>(config: CliAuthConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchGobare(`${config.server.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const payload = (await response.json().catch(() => null)) as { error?: string; code?: string } | T | null
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? `${payload.code ? `[${payload.code}] ` : ''}${payload.error}`
      : 'Gobare CLI request failed.'
    throw new Error(message)
  }
  return payload as T
}

export async function createPiImport(
  config: CliAuthConfig,
  input: {
    transferId: string
    idempotencyKey: string
    projectName: string
    manifest: PiTransferManifest
  },
): Promise<CreatedPiImport> {
  return apiRequest<CreatedPiImport>(config, '/api/cli/pi-imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function uploadPiImportPayload(
  config: CliAuthConfig,
  transferId: string,
  sessionBytes: Uint8Array,
  workspaceBytes?: Uint8Array,
  environmentBytes?: Uint8Array,
): Promise<PiImportStatus> {
  const form = new FormData()
  form.set('piSession', new Blob([sessionBytes], { type: 'application/jsonl' }), 'pi-session.jsonl')
  if (workspaceBytes) form.set('workspace', new Blob([workspaceBytes], { type: 'application/gzip' }), 'workspace.tgz')
  if (environmentBytes) form.set('environment', new Blob([environmentBytes], { type: 'application/json' }), 'environment.json')
  return apiRequest<PiImportStatus>(config, `/api/cli/pi-imports/${encodeURIComponent(transferId)}/payload`, {
    method: 'PUT',
    body: form,
  })
}

export async function getPiImport(config: CliAuthConfig, transferId: string): Promise<PiImportStatus> {
  return apiRequest<PiImportStatus>(config, `/api/cli/pi-imports/${encodeURIComponent(transferId)}`)
}

/** Downloads only the caller's own completed native Pi checkpoint. Never log or cache its bytes. */
async function downloadPiCheckpoint(config: CliAuthConfig, path: string): Promise<Uint8Array> {
  const response = await fetchGobare(`${config.server.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/x-ndjson' },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null
    const message = typeof payload?.error === 'string' ? payload.error : 'Gobare could not export this Pi session.'
    const code = typeof payload?.code === 'string' ? `[${payload.code}] ` : ''
    throw new Error(`${code}${message}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/x-ndjson')) throw new Error('Gobare returned an invalid Pi export response.')
  return new Uint8Array(await response.arrayBuffer())
}

export async function downloadPiImportCheckpoint(
  config: CliAuthConfig,
  transferId: string,
): Promise<Uint8Array> {
  return downloadPiCheckpoint(
    config,
    `/api/cli/pi-imports/${encodeURIComponent(transferId)}/export`,
  )
}

export async function downloadPiProjectCheckpoint(
  config: CliAuthConfig,
  projectId: string,
): Promise<Uint8Array> {
  return downloadPiCheckpoint(
    config,
    `/api/cli/pi-imports/project/${encodeURIComponent(projectId)}/export`,
  )
}
