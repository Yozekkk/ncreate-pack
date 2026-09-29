import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { activateChannel } from '../scripts/activate-channel.mjs'
import { buildRelease, compareVersions, safePackPath, sha256File } from '../scripts/prepare-release.mjs'
import { verifyReleaseAssets } from '../scripts/verify-release-assets.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ncreate-pack-test-'))
  mkdirSync(path.join(root, 'schema'), { recursive: true })
  mkdirSync(path.join(root, 'channels/stable'), { recursive: true })
  mkdirSync(path.join(root, 'channels/beta'), { recursive: true })
  cpSync(path.join(repositoryRoot, 'schema/official-edition-v1.schema.json'),
    path.join(root, 'schema/official-edition-v1.schema.json'))
  cpSync(path.join(repositoryRoot, 'tests/fixtures/packs'), path.join(root, 'packs'), { recursive: true })
  return root
}

test('builds a schema-valid, hashed versioned release and advances only its channel', () => {
  const root = fixture()
  try {
    const output = path.join(root, 'out')
    const { manifest, tag, assetsDirectory } = buildRelease({ root, edition: 'ncreate-server', channel: 'stable', version: '1.2.3', output })
    assert.equal(tag, 'pack-ncreate-server-stable-v1.2.3')
    assert.equal(manifest.releaseChannel, 'stable')
    assert.equal(manifest.files.length, 1)
    assert.equal(manifest.files[0].path, 'config/example.toml')
    assert.match(manifest.files[0].url, /raw\.githubusercontent\.com\/Yozekkk\/ncreate-pack\/pack-ncreate-server-stable-v1\.2\.3\/packs\/ncreate-server\/1\.2\.3\/files\/config\/example\.toml$/)
    const asset = path.join(root, 'packs/ncreate-server/1.2.3/files/config/example.toml')
    assert.equal(manifest.files[0].sha256, sha256File(asset))
    assert.equal(manifest.files[0].size, statSync(asset).size)
    const checksums = readFileSync(path.join(assetsDirectory, 'SHA256SUMS.txt'), 'utf8')
    assert.match(checksums, /manifest\.json/)
    assert.equal(activateChannel({ root, edition: 'ncreate-server', channel: 'stable', manifestPath: path.join(output, 'manifest.json') }), true)
    assert.equal(activateChannel({ root, edition: 'ncreate-server', channel: 'stable', manifestPath: path.join(output, 'manifest.json') }), false)
    assert.equal(readFileSync(path.join(root, 'channels/stable/ncreate-server.json'), 'utf8'),
      readFileSync(path.join(output, 'manifest.json'), 'utf8'))
    assert.throws(() => buildRelease({ root, edition: 'ncreate-server', channel: 'stable', version: '1.2.3', output: path.join(root, 'out2') }), /advance/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects unsafe pack paths, remote commands and mismatched release assets', () => {
  for (const value of ['../saves/x', 'Saves/world.dat', 'mods/installer.exe', 'mods/x:ads.jar', 'mods/CON.txt', 'mods\\x.jar']) {
    assert.throws(() => safePackPath(value), value)
  }
  const root = fixture()
  try {
    const source = path.join(root, 'packs/ncreate-server/1.2.3/edition.json')
    const metadata = JSON.parse(readFileSync(source, 'utf8'))
    metadata.launch = { jvmArgs: ['-javaagent:evil.jar'] }
    writeFileSync(source, JSON.stringify(metadata))
    assert.throws(() => buildRelease({ root, edition: 'ncreate-server', channel: 'stable', version: '1.2.3', output: path.join(root, 'bad') }), /security review/)
    delete metadata.launch
    writeFileSync(source, JSON.stringify(metadata))
    const output = path.join(root, 'good')
    const { assetsDirectory } = buildRelease({ root, edition: 'ncreate-server', channel: 'stable', version: '1.2.3', output })
    const assets = ['manifest.json', 'SHA256SUMS.txt']
    const remote = { assets: assets.map((name) => ({ name, size: statSync(path.join(assetsDirectory, name)).size, digest: `sha256:${sha256File(path.join(assetsDirectory, name))}` })) }
    const remotePath = path.join(root, 'remote.json')
    writeFileSync(remotePath, JSON.stringify(remote))
    assert.equal(verifyReleaseAssets(assetsDirectory, remotePath), 2)
    remote.assets[0].digest = `sha256:${createHash('sha256').update('wrong').digest('hex')}`
    writeFileSync(remotePath, JSON.stringify(remote))
    assert.throws(() => verifyReleaseAssets(assetsDirectory, remotePath), /differs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('versions are monotonic across stable and prerelease identifiers', () => {
  assert.equal(compareVersions('1.4.0', '1.3.9'), 1)
  assert.equal(compareVersions('1.4.0-beta.2', '1.4.0-beta.1'), 1)
  assert.equal(compareVersions('1.4.0-beta.1', '1.4.0'), -1)
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0)
  assert.equal(compareVersions('1.4.0-beta.9007199254740993', '1.4.0-beta.9007199254740992'), 1)
  assert.throws(() => compareVersions('1.4.0-beta.01', '1.4.0-beta.1'))
  assert.throws(() => compareVersions('1.4.0-beta..1', '1.4.0-beta.1'))
  assert.throws(() => compareVersions('1.4.0;rm -rf /', '1.3.0'))
})
