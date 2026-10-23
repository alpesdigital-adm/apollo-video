import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Run through tsx (see test:integration:face-window-composition): the factory pulls in the whole composition root.
const pick = (module, name) => module[name] ?? module.default?.[name]
const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
// W62 timeline window worker and W65b source window worker share one analyzer composition, and so one set of refusals.
const workers = { timeline: pick(factory, 'createFaceWindowWorker'), source: pick(factory, 'createFaceSourceWindowWorker') }
const inventory = await import('../../src/v2/infrastructure/perception/face-runtime-inventory.ts')
const buildFaceRuntimeManifest = pick(inventory, 'buildFaceRuntimeManifest')
const faceRuntimeManifestSha256 = pick(inventory, 'faceRuntimeManifestSha256')

for (const [profile, createFaceWindowWorker] of Object.entries(workers)) test(`the V9 ${profile} worker composition fails closed: unaccepted platform, missing pins, drifted runtime`, async () => {
  assert.equal(typeof createFaceWindowWorker, 'function')
  // A platform with no parity receipt: nothing else is even looked at.
  for (const platform of ['darwin', 'freebsd']) {
    await assert.rejects(createFaceWindowWorker({}, undefined, platform), (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /parity receipt/.test(error.message))
  }
  // Linux has a receipt, but only for the exact interpreter, runtime manifest and bridge bytes it names: none configured, or any one
  // different, is refused before the runtime is even read.
  const linuxPins = { APOLLO_V2_FACE_V9_PYTHON_SHA256: 'e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f',
    APOLLO_V2_FACE_V9_RUNTIME_MANIFEST_SHA256: '5d5fbba5262fcbd90921e05ba604e0ad2f580610eca81851879b7ff551b936a8',
    APOLLO_V2_FACE_V9_BRIDGE_SHA256: '36be4b382b6604244c50aec3bb1d11bb312d6c7faad8fc4799ed9b451c7682e3' }
  await assert.rejects(createFaceWindowWorker({}, undefined, 'linux'),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /differ from the parity receipt for platform linux: PYTHON_EXECUTABLE_PIN_MISMATCH, RUNTIME_MANIFEST_PIN_MISMATCH, BRIDGE_PIN_MISMATCH/.test(error.message))
  for (const [key, reason] of [['APOLLO_V2_FACE_V9_PYTHON_SHA256', 'PYTHON_EXECUTABLE_PIN_MISMATCH'], ['APOLLO_V2_FACE_V9_RUNTIME_MANIFEST_SHA256', 'RUNTIME_MANIFEST_PIN_MISMATCH'],
    ['APOLLO_V2_FACE_V9_BRIDGE_SHA256', 'BRIDGE_PIN_MISMATCH']]) {
    await assert.rejects(createFaceWindowWorker({ ...linuxPins, [key]: 'f'.repeat(64) }, undefined, 'linux'),
      (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && error.message.endsWith(`linux: ${reason}`))
  }
  // With every pinned byte equal the pin check passes and the ordinary inputs are required, starting with the runtime root.
  await assert.rejects(createFaceWindowWorker(linuxPins, undefined, 'linux'),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED' && /APOLLO_V2_FACE_V9_PYTHON_MODULE_DIR/.test(error.message))
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
