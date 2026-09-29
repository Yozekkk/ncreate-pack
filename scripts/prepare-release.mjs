import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const editions = new Set(['ncreate-server'])
const channels = new Set(['stable', 'beta'])
const protectedRoots = new Set([
  'saves', 'screenshots', 'logs', 'options.txt', 'servers.dat',
  '.ncreate-runtime', '.ncreate-icon.png',
])
const executableExtensions = new Set([
  '.exe', '.com', '.msi', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh',
])
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/

export function parseVersion(value) {
  const match = versionPattern.exec(value)
  if (!match) throw new Error('version must be a SemVer release without build metadata')
  if (match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error('version component exceeds the supported range')
  }
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => !/^[0-9A-Za-z-]+$/.test(part) || (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))) {
    throw new Error('invalid SemVer prerelease identifier')
  }
  return {
    parts: match.slice(1, 4).map(Number),
    prerelease,
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return Math.sign(a.parts[index] - b.parts[index])
  }
  if (!a.prerelease.length && b.prerelease.length) return 1
  if (a.prerelease.length && !b.prerelease.length) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric && x !== y) return x.length !== y.length ? Math.sign(x.length - y.length) : (x < y ? -1 : 1)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function safePackPath(relative) {
  if (!relative || relative.length > 1024 || relative.includes('\\') || relative.startsWith('/')) {
    throw new Error(`unsafe pack path: ${relative}`)
  }
  const segments = relative.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.length > 255 ||
        /[\x00-\x1f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new Error(`unsafe pack path: ${relative}`)
    }
  }
  if (protectedRoots.has(segments[0].toLowerCase()) ||
      executableExtensions.has(path.posix.extname(relative).toLowerCase())) {
    throw new Error(`protected or executable pack path: ${relative}`)
  }
  return relative
}

function filesIn(directory, prefix = '') {
  if (!existsSync(directory)) throw new Error(`missing pack files directory: ${directory}`)
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = safePackPath(prefix ? `${prefix}/${entry.name}` : entry.name)
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`symlink in pack files: ${relative}`)
    if (entry.isDirectory()) result.push(...filesIn(absolute, relative))
    else if (entry.isFile()) result.push({ relative, absolute })
    else throw new Error(`unsupported pack file type: ${relative}`)
  }
  return result.sort((a, b) => a.relative.localeCompare(b.relative, 'en'))
}

export function sha256File(file) {
  const digest = createHash('sha256')
  const handle = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const length = readSync(handle, buffer, 0, buffer.length, null)
      if (!length) break
      digest.update(buffer.subarray(0, length))
    }
  } finally {
    closeSync(handle)
  }
  return digest.digest('hex')
}

function schemaValidator(root) {
  const schema = JSON.parse(readFileSync(path.join(root, 'schema/official-edition-v1.schema.json'), 'utf8'))
  const ajv = new Ajv2020({ allErrors: true })
  addFormats(ajv)
  return ajv.compile(schema)
}

export function validateManifest(manifest, root) {
  const validate = schemaValidator(root)
  if (!validate(manifest)) throw new Error(`invalid edition manifest: ${JSON.stringify(validate.errors)}`)
}

export function buildRelease({ root, edition, channel, version, output, repository = 'Yozekkk/ncreate-pack' }) {
  if (!editions.has(edition) || !channels.has(channel)) throw new Error('unknown edition or channel')
  parseVersion(version)
  if (repository !== 'Yozekkk/ncreate-pack') throw new Error('unexpected manifest repository')
  const source = path.join(root, 'packs', edition, version)
  const input = JSON.parse(readFileSync(path.join(source, 'edition.json'), 'utf8'))
  if (input.id !== edition || input.version !== version || input.schemaVersion !== 1 ||
      Object.hasOwn(input, 'files') || Object.hasOwn(input, 'releaseChannel')) {
    throw new Error('edition metadata does not match the requested release')
  }
  if ((input.launch?.jvmArgs?.length ?? 0) || (input.launch?.gameArgs?.length ?? 0)) {
    throw new Error('remote launch arguments require separate security review')
  }
  if (typeof input.changelog !== 'string' || !input.changelog.trim() || input.changelog.length > 32768) {
    throw new Error('edition changelog is required and must be concise')
  }
  if (input.name !== 'NCreate Server') {
    throw new Error('official pack name must be NCreate Server')
  }
  const policiesPath = path.join(source, 'file-policies.json')
  const policies = existsSync(policiesPath) ? JSON.parse(readFileSync(policiesPath, 'utf8')) : {}
  if (!policies || Array.isArray(policies) || typeof policies !== 'object') {
    throw new Error('file policies must be an object')
  }
  const payloads = filesIn(path.join(source, 'files'))
	if (payloads.some(({ relative }) => relative.startsWith('mods/') && relative.endsWith('.jar'))) {
		throw new Error('third-party mod JARs must use reviewed upstream sources, not release assets')
	}
  const externalSourcesPath = path.join(source, 'external-sources.json')
  const externalSources = existsSync(externalSourcesPath)
    ? JSON.parse(readFileSync(externalSourcesPath, 'utf8')) : {}
  if (existsSync(path.join(source, 'UNRESOLVED.json'))) {
    throw new Error('unresolved third-party files block publication')
  }
  if (!externalSources || Array.isArray(externalSources) || typeof externalSources !== 'object') {
    throw new Error('external sources must be an object')
  }
  const paths = new Set(payloads.map(({ relative }) => relative.toLowerCase()))
  for (const relative of Object.keys(externalSources)) {
    safePackPath(relative)
    const folded = relative.toLowerCase()
    if (paths.has(folded)) throw new Error(`duplicate local and external path: ${relative}`)
    paths.add(folded)
  }
  if (paths.size !== payloads.length + Object.keys(externalSources).length) {
    throw new Error('case-insensitive duplicate pack paths')
  }
  for (const relative of Object.keys(policies)) {
    safePackPath(relative)
    if (!payloads.some((file) => file.relative === relative) && !Object.hasOwn(externalSources, relative)) {
      throw new Error(`file policy has no matching payload: ${relative}`)
    }
  }
  const tag = `pack-${edition}-${channel}-v${version}`
  const assetsDirectory = path.join(output, 'release-assets')
  if (existsSync(assetsDirectory) && readdirSync(assetsDirectory).length) {
    throw new Error('release output directory is not empty')
  }
  mkdirSync(assetsDirectory, { recursive: true })
  let totalSize = 0
  const files = payloads.map(({ relative, absolute }) => {
    if (relative.startsWith('mods/') || /\.(jar|mrpack)$/i.test(relative)) {
      throw new Error(`mod files must use a verified upstream source: ${relative}`)
    }
    const size = lstatSync(absolute).size
    totalSize += size
    if (size > 2 * 1024 ** 3 || totalSize > 32 * 1024 ** 3) {
      throw new Error('pack exceeds launcher download limits')
    }
    const policy = policies[relative] ?? {}
    if (!policy || Array.isArray(policy) || typeof policy !== 'object' ||
        Object.keys(policy).some((key) => !['required', 'updatePolicy'].includes(key)) ||
        (policy.required !== undefined && typeof policy.required !== 'boolean') ||
        (policy.updatePolicy !== undefined && !['managed_only', 'preserve'].includes(policy.updatePolicy))) {
      throw new Error(`invalid file policy: ${relative}`)
    }
    const encoded = relative.split('/').map(encodeURIComponent).join('/')
    return {
      path: relative,
      url: `https://raw.githubusercontent.com/${repository}/${tag}/packs/${edition}/${version}/files/${encoded}`,
      sha256: sha256File(absolute),
      size,
      required: policy.required ?? true,
      updatePolicy: policy.updatePolicy ?? 'managed_only',
    }
  })
  for (const [relative, source] of Object.entries(externalSources).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!source || Array.isArray(source) || typeof source !== 'object' ||
        Object.keys(source).some((key) => !['url', 'sha256', 'size', 'provider', 'projectId', 'versionId', 'fileId', 'sourcePage'].includes(key)) ||
        !['modrinth', 'modrinth-cdn', 'ftb', 'curseforge'].includes(source.provider) ||
        !/^[a-f0-9]{64}$/.test(source.sha256 ?? '') ||
        !Number.isSafeInteger(source.size) || source.size < 0 || source.size > 2 * 1024 ** 3) {
      throw new Error(`invalid external source metadata: ${relative}`)
    }
    if (typeof source.url !== 'string') throw new Error(`external source URL is missing: ${relative}`)
    const url = new URL(source.url)
    const hosts = {
      modrinth: 'cdn.modrinth.com', 'modrinth-cdn': 'cdn.modrinth.com',
      ftb: 'maven.ftb.dev', curseforge: 'mediafilez.forgecdn.net',
    }
    if (url.protocol !== 'https:' || url.hostname !== hosts[source.provider] ||
        url.username || url.password || url.port || url.search || url.hash) {
      throw new Error(`external source is not an approved immutable HTTPS URL: ${relative}`)
    }
    if (source.provider === 'modrinth' &&
        (!/^[A-Za-z0-9]{8}$/.test(source.projectId ?? '') ||
         !/^[A-Za-z0-9]{8}$/.test(source.versionId ?? '') ||
         !url.pathname.startsWith(`/data/${source.projectId}/versions/`))) {
      throw new Error(`Modrinth source metadata is invalid: ${relative}`)
    }
    if (source.provider === 'curseforge' &&
        (!Number.isSafeInteger(source.projectId) || !Number.isSafeInteger(source.fileId) ||
         !url.pathname.startsWith('/files/'))) {
      throw new Error(`CurseForge source metadata is invalid: ${relative}`)
    }
    if (source.provider !== 'modrinth' &&
        (typeof source.sourcePage !== 'string' || !source.sourcePage.startsWith('https://'))) {
      throw new Error(`reviewed source page is missing: ${relative}`)
    }
    totalSize += source.size
    if (totalSize > 32 * 1024 ** 3) throw new Error('pack exceeds launcher download limits')
    const policy = policies[relative] ?? {}
    if (!policy || Array.isArray(policy) || typeof policy !== 'object' ||
        Object.keys(policy).some((key) => !['required', 'updatePolicy'].includes(key)) ||
        (policy.required !== undefined && typeof policy.required !== 'boolean') ||
        (policy.updatePolicy !== undefined && !['managed_only', 'preserve'].includes(policy.updatePolicy))) {
      throw new Error(`invalid file policy: ${relative}`)
    }
    const provenance = { provider: source.provider }
    for (const key of ['projectId', 'versionId', 'fileId', 'sourcePage']) {
      if (source[key] !== undefined) provenance[key] = source[key]
    }
    files.push({
      path: relative, url: source.url, sha256: source.sha256, size: source.size,
      required: policy.required ?? true,
      updatePolicy: policy.updatePolicy ?? 'managed_only',
      source: provenance,
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const manifest = { ...input, releaseChannel: channel, files }
  validateManifest(manifest, root)
  const currentChannelPath = path.join(root, 'channels', channel, `${edition}.json`)
  if (existsSync(currentChannelPath)) {
    const current = JSON.parse(readFileSync(currentChannelPath, 'utf8'))
    if (compareVersions(version, current.version) <= 0) {
      throw new Error('new release must advance the channel version')
    }
  }
  writeFileSync(path.join(assetsDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const assetNames = readdirSync(assetsDirectory).filter((name) => name !== 'SHA256SUMS.txt').sort()
  const checksums = assetNames.map((name) => `${sha256File(path.join(assetsDirectory, name))}  ${name}`).join('\n')
  writeFileSync(path.join(assetsDirectory, 'SHA256SUMS.txt'), `${checksums}\n`)
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(path.join(output, 'release-notes.md'),
    `# NCreate ${edition} ${version}\n\nChannel: ${channel}\n\n${input.changelog.trim()}\n`)
  writeFileSync(path.join(output, 'tag.txt'), `${tag}\n`)
  return { manifest, tag, assetsDirectory }
}

function optionsFromCli(arguments_) {
  const options = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    if (!key?.startsWith('--') || !arguments_[index + 1]) throw new Error('expected --key value arguments')
    options[key.slice(2)] = arguments_[index + 1]
  }
  return options
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const args = optionsFromCli(process.argv.slice(2))
    const result = buildRelease({
      root: path.resolve(args.root ?? '.'),
      edition: args.edition,
      channel: args.channel,
      version: args.version,
      output: path.resolve(args.output ?? 'dist'),
    })
    process.stdout.write(`${result.tag}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
