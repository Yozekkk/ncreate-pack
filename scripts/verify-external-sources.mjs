import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const maxRedirects = 3
const maxFileSize = 2 * 1024 ** 3

function approvedSourceUrl(source, url) {
  const parsed = new URL(url)
  const hosts = {
    modrinth: 'cdn.modrinth.com', 'modrinth-cdn': 'cdn.modrinth.com',
    ftb: 'maven.ftb.dev', curseforge: 'mediafilez.forgecdn.net',
  }
  return parsed.protocol === 'https:' && parsed.hostname === hosts[source.provider] &&
    !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash
}

async function fetchStrict(source, url, fetchFn) {
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchFn(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'NCreatePackPublisher/1.0 (+https://github.com/Yozekkk/ncreate-pack)' },
      signal: AbortSignal.timeout(180_000),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location')
      if (!next) throw new Error(`redirect without destination: ${url}`)
      const resolved = new URL(next, url).href
      if (!approvedSourceUrl(source, resolved)) throw new Error(`unsafe CDN redirect: ${resolved}`)
      url = resolved
      continue
    }
    if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}: ${url}`)
    return response
  }
  throw new Error('too many CDN redirects')
}

export async function verifyExternalSource({ relative, source, manifestFile, fetchFn = fetch }) {
  if (!approvedSourceUrl(source, source.url) || source.url !== manifestFile.url ||
      source.sha256 !== manifestFile.sha256 || source.size !== manifestFile.size ||
      !Number.isSafeInteger(source.size) || source.size > maxFileSize) {
    throw new Error(`external source differs from manifest: ${relative}`)
  }
  if (source.provider === 'modrinth') {
    const apiUrl = `https://api.modrinth.com/v2/version/${source.versionId}`
    const metadataResponse = await fetchFn(apiUrl, {
      redirect: 'error',
      headers: { 'User-Agent': 'NCreatePackPublisher/1.0 (+https://github.com/Yozekkk/ncreate-pack)' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!metadataResponse.ok) throw new Error(`Modrinth version lookup failed: ${relative}`)
    const version = await metadataResponse.json()
    if (version.id !== source.versionId || version.project_id !== source.projectId ||
        !version.files?.some((file) => file.url === source.url && file.size === source.size)) {
      throw new Error(`Modrinth version does not list the exact file: ${relative}`)
    }
  }
  const response = await fetchStrict(source, source.url, fetchFn)
  const statedLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(statedLength) && statedLength > 0 && statedLength !== source.size) {
    throw new Error(`upstream Content-Length differs: ${relative}`)
  }
  if (!response.body) throw new Error(`empty upstream response: ${relative}`)
  const digest = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > source.size || size > maxFileSize) throw new Error(`upstream file is oversized: ${relative}`)
    digest.update(chunk)
  }
  if (size !== source.size || digest.digest('hex') !== source.sha256) {
    throw new Error(`upstream file checksum differs: ${relative}`)
  }
}

export async function verifyExternalSources({ root, manifestPath, fetchFn = fetch }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const sourcePath = path.join(root, 'packs', manifest.id, manifest.version, 'external-sources.json')
  let sources
  try { sources = JSON.parse(readFileSync(sourcePath, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  const files = new Map(manifest.files.map((file) => [file.path, file]))
  for (const [relative, source] of Object.entries(sources)) {
    const file = files.get(relative)
    if (!file) throw new Error(`source has no matching manifest file: ${relative}`)
    await verifyExternalSource({ relative, source, manifestFile: file, fetchFn })
  }
  return Object.keys(sources).length
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [manifestPath] = process.argv.slice(2)
    if (!manifestPath) throw new Error('usage: verify-external-sources.mjs MANIFEST')
    const count = await verifyExternalSources({ root: process.cwd(), manifestPath: path.resolve(manifestPath) })
    process.stdout.write(`verified ${count} upstream files\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
