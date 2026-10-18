import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Run through tsx (see test:integration:face-window-composition): the factory pulls in the whole composition root.
const pick = (module, name) => module[name] ?? module.default?.[name]
const { createFaceWindowWorker } = await import('../../src/v2/infrastructure/repository-factory.ts').then((module) => ({ createFaceWindowWorker: pick(module, 'createFaceWindowWorker') }))
const inventory = await import('../../src/v2/infrastructure/perception/face-runtime-inventory.ts')
const buildFaceRuntimeManifest = pick(inventory, 'buildFaceRuntimeManifest')
const faceRuntimeManifestSha256 = pick(inventory, 'faceRuntimeManifestSha256')

test('the V9 worker composition fails closed: unaccepted platform, missing pins, drifted runtime', async () => {
  // Linux has no passed parity receipt, so nothing else is even looked at.
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    await assert.rejects(createFaceWindowWorker({}, undefined, platform), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /parity receipt/.test(error.message))
  }
  // On the accepted platform every pinned input is still required, starting with the runtime root.
  await assert.rejects(createFaceWindowWorker({}, undefined, 'win32'), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /APOLLO_V2_FACE_V9_PYTHON_MODULE_DIR/.test(error.message))

  const root = await mkdtemp(join(tmpdir(), 'apollo-face-composition-'))
  try {
    const runtime = join(root, 'site-packages'), manifestPath = join(root, 'manifest.json')
    await mkdir(runtime)
    await writeFile(join(runtime, 'module.py'), 'x = 1\n')
    const manifest = await buildFaceRuntimeManifest(runtime)
    await writeFile(manifestPath, JSON.stringify(manifest))
    const env = { APOLLO_V2_FACE_V9_PYTHON_MODULE_DIR: runtime, APOLLO_V2_FACE_V9_RUNTIME_MANIFEST: manifestPath,
      APOLLO_V2_FACE_V9_RUNTIME_MANIFEST_SHA256: faceRuntimeManifestSha256(manifest) }

    // a manifest hash that is not the pinned one
    await assert.rejects(createFaceWindowWorker({ ...env, APOLLO_V2_FACE_V9_RUNTIME_MANIFEST_SHA256: 'f'.repeat(64) }, undefined, 'win32'),
      (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /pinned hash/.test(error.message))
    // a verified runtime but a missing interpreter pin
    await assert.rejects(createFaceWindowWorker(env, undefined, 'win32'),
      (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /APOLLO_V2_FACE_V9_PYTHON_BIN/.test(error.message))
    // a runtime file edited after the manifest was pinned
    await writeFile(join(runtime, 'module.py'), 'x = 2\n')
    await assert.rejects(createFaceWindowWorker(env, undefined, 'win32'), { code: 'PERSISTENCE_CONFLICT' })
    // an unlisted file added to the package root
    await writeFile(join(runtime, 'module.py'), 'x = 1\n')
    await writeFile(join(runtime, 'extra.py'), 'y = 1\n')
    await assert.rejects(createFaceWindowWorker(env, undefined, 'win32'), { code: 'PERSISTENCE_CONFLICT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
