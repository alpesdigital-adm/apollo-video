import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildFaceRuntimeManifest, FaceRuntimeInventory, faceRuntimeManifestSha256 } from '../../src/v2/infrastructure/perception/face-runtime-inventory.ts'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'apollo-face-runtime-'))
  const root = join(base, 'site-packages')
  await mkdir(join(root, 'openvino', 'libs'), { recursive: true })
  await writeFile(join(root, 'openvino', '__init__.py'), 'x = 1\n')
  await writeFile(join(root, 'openvino', 'libs', 'core.dll'), Buffer.alloc(2048, 7))
  await writeFile(join(root, 'numpy.py'), 'y = 2\n')
  const manifest = await buildFaceRuntimeManifest(root)
  const manifestPath = join(base, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { base, root, manifest, manifestPath, manifestSha256: faceRuntimeManifestSha256(manifest) }
}
const load = (f, extra = {}) => FaceRuntimeInventory.load({ root: f.root, manifestPath: f.manifestPath, manifestSha256: f.manifestSha256, ...extra })

test('the manifest lists every file with hash and size and is pinned by its canonical hash', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(f.manifest.files.map((file) => file.path), ['numpy.py', 'openvino/__init__.py', 'openvino/libs/core.dll'])
    assert.ok(f.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256) && file.bytes > 0))
    const inventory = await load(f)
    await inventory.verifyFull()
    await inventory.verify()
    await assert.rejects(FaceRuntimeInventory.load({ root: f.root, manifestPath: f.manifestPath, manifestSha256: 'a'.repeat(64) }), /differs from its pinned hash/)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('an edited, swapped, added or removed file is refused by the full verification', async () => {
  const f = await fixture()
  try {
    const inventory = await load(f)
    await inventory.verifyFull()
    await writeFile(join(f.root, 'numpy.py'), 'y = 3\n')
    await assert.rejects(inventory.verifyFull(), /differs from its pinned hash/)
    await writeFile(join(f.root, 'numpy.py'), 'y = 2\n')
    await inventory.verifyFull()
    await writeFile(join(f.root, 'extra.py'), 'z = 1\n')
    await assert.rejects(inventory.verifyFull(), /drifted/)
    await rm(join(f.root, 'extra.py'))
    await rm(join(f.root, 'numpy.py'))
    await assert.rejects(inventory.verifyFull(), /drifted/)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('the quick check catches a file whose size or modification time changed, and escalates when none is current', async () => {
  const f = await fixture()
  try {
    let clock = 1_000
    const inventory = await load(f, { fullVerifyIntervalMs: 10_000, now: () => clock })
    await inventory.verify() // no fingerprint yet: this is the full verification
    await inventory.verify()
    await writeFile(join(f.root, 'numpy.py'), 'y = 22\n') // different size
    await assert.rejects(inventory.verify(), /changed since verification/)
    await writeFile(join(f.root, 'numpy.py'), 'y = 2\n')
    await inventory.verifyFull()
    await utimes(join(f.root, 'numpy.py'), new Date(), new Date(Date.now() + 5_000)) // same bytes, new mtime
    await assert.rejects(inventory.verify(), /changed since verification/)
    await inventory.verifyFull()
    // Past the interval a full verification runs again and catches an edit that kept size and mtime.
    clock += 20_000
    await writeFile(join(f.root, 'numpy.py'), 'y = 9\n')
    await utimes(join(f.root, 'numpy.py'), new Date(), new Date(Date.now() + 5_000))
    await assert.rejects(inventory.verify(), /pinned hash|changed since/)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('links, malformed manifests and relative configuration are refused', async () => {
  const f = await fixture()
  try {
    await assert.rejects(FaceRuntimeInventory.load({ root: 'relative', manifestPath: f.manifestPath, manifestSha256: f.manifestSha256 }), /configuration is invalid/)
    const bad = join(f.base, 'bad.json')
    await writeFile(bad, JSON.stringify({ schemaVersion: 'face-runtime-manifest/v1', files: [{ path: '../escape', sha256: 'a'.repeat(64), bytes: 1 }] }))
    await assert.rejects(FaceRuntimeInventory.load({ root: f.root, manifestPath: bad, manifestSha256: 'a'.repeat(64) }), /entry is invalid/)
    await writeFile(bad, JSON.stringify({ schemaVersion: 'face-runtime-manifest/v1', files: [], extra: 1 }))
    await assert.rejects(FaceRuntimeInventory.load({ root: f.root, manifestPath: bad, manifestSha256: 'a'.repeat(64) }), /manifest is invalid/)
    await writeFile(bad, 'not json')
    await assert.rejects(FaceRuntimeInventory.load({ root: f.root, manifestPath: bad, manifestSha256: 'a'.repeat(64) }), /unreadable/)
    await symlink(join(f.root, 'numpy.py'), join(f.root, 'link.py')).then(async () => {
      await assert.rejects(buildFaceRuntimeManifest(f.root), /contains a link/)
      const inventory = await load(f)
      await assert.rejects(inventory.verifyFull(), /contains a link/)
    }, () => { /* symlink creation needs privileges on some hosts; the rest of the contract is covered above */ })
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('the provisioning script writes the manifest exclusively and prints the hash to pin', async () => {
  const f = await fixture()
  try {
    const { main } = await import('../../scripts/ops/build-face-runtime-manifest.mjs')
    const out = join(f.base, 'provisioned.json')
    const lines = []
    const original = console.log
    console.log = (line) => lines.push(line)
    let result
    try { result = await main(['--root', f.root, '--out', out]) } finally { console.log = original }
    assert.equal(result.manifestSha256, f.manifestSha256)
    assert.equal(JSON.parse(lines[0]).files, 3)
    const inventory = await FaceRuntimeInventory.load({ root: f.root, manifestPath: out, manifestSha256: result.manifestSha256 })
    await inventory.verifyFull()
    await assert.rejects(main(['--root', f.root, '--out', out]), /EEXIST/)
    await assert.rejects(main(['--root', 'relative', '--out', out]), /absolute/)
    await assert.rejects(main(['--root', f.root]), /absolute|Unexpected/)
    await assert.rejects(main(['--nope', 'x']), /Unexpected/)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})
