import { createHash } from 'node:crypto'

import type { RenderInputAsset } from './render-input.ts'
import {
  materializeCube3dIntensity,
  type WorkspaceLutVersion,
} from './workspace-lut.ts'

const LUT_KEY = /^workspace-luts\/([A-Za-z0-9][A-Za-z0-9._:-]{2,127})\/versions\/([1-9]\d*)\/intensity-(0\.\d{6}|1\.000000)-([a-f0-9]{64})\.cube$/

export interface RenderInputLutIdentity {
  lutId: string
  version: number
  intensity: number
  sha256: string
}

export function parseRenderInputLutIdentity(asset: RenderInputAsset): RenderInputLutIdentity | null {
  if (asset.kind !== 'lut') return null
  const match = LUT_KEY.exec(asset.artifactKey)
  if (!match) return null
  const version = Number(match[2])
  const intensity = Number(match[3])
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isFinite(intensity)) return null
  return Object.freeze({ lutId: match[1]!, version, intensity, sha256: match[4]! })
}

export function materializeRenderInputLut(
  asset: RenderInputAsset,
  version: Readonly<WorkspaceLutVersion>,
): Readonly<{ content: string; sha256: string; byteSize: number }> | null {
  const identity = parseRenderInputLutIdentity(asset)
  if (
    !identity ||
    version.id !== asset.artifactId ||
    version.lutId !== identity.lutId ||
    version.version !== identity.version
  ) return null
  const cube = materializeCube3dIntensity(version.cube.canonicalContent, identity.intensity)
  const sha256 = createHash('sha256').update(cube.canonicalContent, 'utf8').digest('hex')
  const byteSize = Buffer.byteLength(cube.canonicalContent, 'utf8')
  if (
    sha256 !== identity.sha256 ||
    sha256 !== asset.sha256 ||
    byteSize !== asset.byteSize
  ) return null
  return Object.freeze({ content: cube.canonicalContent, sha256, byteSize })
}
