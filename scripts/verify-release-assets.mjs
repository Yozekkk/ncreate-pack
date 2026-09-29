import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File } from './prepare-release.mjs'

export function verifyReleaseAssets(localDirectory, remoteJsonPath) {
  const remote = JSON.parse(readFileSync(remoteJsonPath, 'utf8'))
  if (!Array.isArray(remote.assets)) throw new Error('GitHub release assets are unavailable')
  const assets = readdirSync(localDirectory).sort()
  for (const name of assets) {
    const file = path.join(localDirectory, name)
    const expected = `sha256:${sha256File(file)}`
    const matches = remote.assets.filter((asset) => asset.name === name)
    if (matches.length !== 1 || matches[0].size !== statSync(file).size || matches[0].digest !== expected) {
      throw new Error(`release asset is missing or differs from source: ${name}`)
    }
  }
  if (remote.assets.length !== assets.length) throw new Error('release includes unexpected assets')
  return assets.length
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [directory, remoteJsonPath] = process.argv.slice(2)
    if (!directory || !remoteJsonPath) throw new Error('usage: verify-release-assets.mjs DIRECTORY ASSETS_JSON')
    process.stdout.write(`verified ${verifyReleaseAssets(directory, remoteJsonPath)} release assets\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
