import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, validateManifest } from './prepare-release.mjs'

export function activateChannel({ root, edition, channel, manifestPath }) {
  if (edition !== 'ncreate-server' || !['stable', 'beta'].includes(channel)) {
    throw new Error('unknown edition or channel')
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validateManifest(manifest, root)
  if (manifest.id !== edition || manifest.releaseChannel !== channel) {
    throw new Error('manifest does not match the selected channel')
  }
  const target = path.join(root, 'channels', channel, `${edition}.json`)
  if (existsSync(target)) {
    const previous = JSON.parse(readFileSync(target, 'utf8'))
    const order = compareVersions(manifest.version, previous.version)
    if (order < 0) throw new Error('channel cannot move to an older edition version')
    if (order === 0) {
      if (JSON.stringify(manifest) !== JSON.stringify(previous)) {
        throw new Error('published channel version cannot be changed in place')
      }
      return false
    }
  }
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [edition, channel, manifestPath] = process.argv.slice(2)
    if (!manifestPath) throw new Error('usage: activate-channel.mjs EDITION CHANNEL MANIFEST')
    process.stdout.write(`${activateChannel({ root: process.cwd(), edition, channel, manifestPath }) ? 'updated' : 'unchanged'}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
