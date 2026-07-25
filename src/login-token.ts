function readStandardInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    process.stdin.once('error', reject)
    process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.resume()
  })
}

/**
 * Resolves a login token without requiring the secret to appear in shell history. Supplying an
 * inline value remains backward-compatible, but interactive documentation and automation should
 * prefer stdin or GOBARE_TOKEN.
 */
export async function resolveLoginToken(
  args: string[],
  environmentToken: string | undefined,
  readStdin: () => Promise<string> = readStandardInput,
): Promise<string | undefined> {
  const index = args.indexOf('--token')
  const inline = index >= 0 ? args[index + 1] : undefined
  if (inline && !inline.startsWith('--')) return inline.trim() || undefined
  if (environmentToken?.trim()) return environmentToken.trim()
  if (index < 0) return undefined
  return (await readStdin()).trim() || undefined
}
