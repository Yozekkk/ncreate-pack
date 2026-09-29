import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseVersion, safePackPath, validateManifest } from './prepare-release.mjs'

const root = path.resolve('.')
let count = 0
for (const channel of ['stable', 'beta']) {
  const directory = path.join(root, 'channels', channel)
  if (!existsSync(directory)) continue
  for (const name of readdirSync(directory).filter((value) => value.endsWith('.json'))) {
    const edition = name.slice(0, -5)
    const manifest = JSON.parse(readFileSync(path.join(directory, name), 'utf8'))
    validateManifest(manifest, root)
    parseVersion(manifest.version)
    if (manifest.id !== edition || manifest.releaseChannel !== channel) {
      throw new Error(`channel manifest is misplaced: ${name}`)
    }
    const tag = `pack-${edition}-${channel}-v${manifest.version}`
    for (const file of manifest.files) {
      safePackPath(file.path)
      const prefix = `https://github.com/Yozekkk/ncreate-pack/releases/download/${tag}/file-${createHash('sha256').update(file.path).digest('hex')}`
      const officialDownload = ['https://cdn.modrinth.com/data/', 'https://maven.ftb.dev/',
        'https://mediafilez.forgecdn.net/files/'].some((base) => file.url.startsWith(base))
      if (!file.url.startsWith(`${prefix}.`) && !officialDownload) {
        throw new Error(`file does not use an approved immutable source: ${file.path}`)
      }
    }
    count++
  }
}
process.stdout.write(`validated ${count} published channel manifests\n`)
