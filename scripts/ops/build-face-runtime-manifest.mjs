#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFaceRuntimeManifest, faceRuntimeManifestSha256 } from '../../src/v2/infrastructure/perception/face-runtime-inventory.ts'

/**
 * Provisioning step for the V9 face detector: inventories the private Python package root (OpenVINO, OpenCV, NumPy)
 * into a manifest and prints the SHA-256 to pin as APOLLO_V2_FACE_RUNTIME_MANIFEST_SHA256.
 *
 *   node scripts/ops/build-face-runtime-manifest.mjs --root <site-packages> --out <manifest.json>
 *
 * The manifest is created exclusively (an existing file is never replaced). Building it is an inventory, not an
 * approval: the detector is accepted only on a platform with a passed parity receipt (see the producer registry).
 */
export async function main(argv) {
  const options = { root: null, out: null }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1]
    if ((flag !== '--root' && flag !== '--out') || value === undefined || value.startsWith('--')) throw new Error(`Unexpected argument ${flag ?? ''}`)
    options[flag.slice(2)] = value
  }
  if (!options.root || !options.out || !isAbsolute(options.root) || !isAbsolute(options.out)) throw new Error('--root and --out must be absolute paths')
  const manifest = await buildFaceRuntimeManifest(options.root)
  const bytes = JSON.stringify(manifest)
  await writeFile(options.out, bytes, { flag: 'wx' })
  const result = { out: options.out, files: manifest.files.length, manifestSha256: faceRuntimeManifestSha256(manifest) }
  console.log(JSON.stringify(result))
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
