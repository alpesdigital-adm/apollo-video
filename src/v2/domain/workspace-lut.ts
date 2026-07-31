import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const COLOR_SPACES = ['rec709', 'display-p3', 'rec2020'] as const
const LICENSE_POLICIES = ['owned', 'licensed', 'restricted'] as const
export type LutColorSpace = typeof COLOR_SPACES[number]
export type LutLicensePolicy = typeof LICENSE_POLICIES[number]

export interface ParsedCube3d {
  schemaVersion: 'parsed-cube-3d/v1'; title?: string; size: number
  domainMin: readonly [number, number, number]; domainMax: readonly [number, number, number]
  rows: number; canonicalContent: string; contentHash: string
}
export interface WorkspaceLutVersion {
  schemaVersion: 'workspace-lut-version/v1'; id: string; workspaceId: string; lutId: string; version: number
  name: string; owner: string
  license: Readonly<{ policy: LutLicensePolicy; name: string; usageNotes?: string }>
  tags: readonly string[]
  compatibility: Readonly<{ inputColorSpace: LutColorSpace; outputColorSpace: LutColorSpace }>
  intensity: Readonly<{ default: number; min: 0; max: 1 }>
  cube: Readonly<ParsedCube3d>
  preview: Readonly<{ mediaType: 'image/png'; width: 512; height: 288; byteSize: number; sha256: string }>
  createdByClientId: string; createdAt: string; recordHash: string
}

function textValue(value: unknown, field: string, max: number): string {
  const normalized = typeof value === 'string' ? value.normalize('NFC').trim() : ''
  assertDomain(normalized.length >= 1 && normalized.length <= max && !/[\u0000-\u001f\u007f]/.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function identity(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function triple(value: string, field: string): readonly [number, number, number] {
  const parts = value.trim().split(/\s+/)
  assertDomain(parts.length === 3, 'INVALID_ARGUMENT', `${field} must contain three values`)
  const numbers = parts.map(Number)
  assertDomain(numbers.every((item) => Number.isFinite(item) && item >= -16 && item <= 16), 'INVALID_ARGUMENT', `${field} contains an invalid value`)
  return Object.freeze(numbers as [number, number, number])
}
function canonicalNumber(value: number): string {
  const fixed = value.toFixed(10).replace(/\.?0+$/, '')
  return fixed === '-0' ? '0' : fixed
}

export function parseCube3d(content: string): Readonly<ParsedCube3d> {
  assertDomain(typeof content === 'string' && Buffer.byteLength(content, 'utf8') <= 8 * 1024 * 1024, 'INVALID_ARGUMENT', '.cube content exceeds 8 MiB')
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let title: string | undefined
  let size: number | undefined
  let domainMin: readonly [number, number, number] = Object.freeze([0, 0, 0])
  let domainMax: readonly [number, number, number] = Object.freeze([1, 1, 1])
  let seenDomainMin = false
  let seenDomainMax = false
  const rows: Array<readonly [number, number, number]> = []
  let dataStarted = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const titleMatch = line.match(/^TITLE\s+"([\s\S]*)"$/i)
    if (titleMatch) {
      assertDomain(!dataStarted && title === undefined, 'INVALID_ARGUMENT', '.cube TITLE is duplicated or misplaced')
      title = textValue(titleMatch[1]!.replace(/\\"/g, '"'), 'cube.title', 240)
      continue
    }
    const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)$/i)
    if (sizeMatch) {
      assertDomain(!dataStarted && size === undefined, 'INVALID_ARGUMENT', 'LUT_3D_SIZE is duplicated or misplaced')
      size = Number(sizeMatch[1])
      assertDomain(Number.isSafeInteger(size) && size >= 2 && size <= 65, 'INVALID_ARGUMENT', 'LUT_3D_SIZE must be between 2 and 65')
      continue
    }
    const minMatch = line.match(/^DOMAIN_MIN\s+(.+)$/i)
    if (minMatch) {
      assertDomain(!dataStarted && !seenDomainMin, 'INVALID_ARGUMENT', 'DOMAIN_MIN is duplicated or misplaced')
      domainMin = triple(minMatch[1]!, 'DOMAIN_MIN'); seenDomainMin = true; continue
    }
    const maxMatch = line.match(/^DOMAIN_MAX\s+(.+)$/i)
    if (maxMatch) {
      assertDomain(!dataStarted && !seenDomainMax, 'INVALID_ARGUMENT', 'DOMAIN_MAX is duplicated or misplaced')
      domainMax = triple(maxMatch[1]!, 'DOMAIN_MAX'); seenDomainMax = true; continue
    }
    assertDomain(size !== undefined, 'INVALID_ARGUMENT', 'LUT_3D_SIZE must precede data')
    assertDomain(!/^[A-Za-z_]/.test(line), 'INVALID_ARGUMENT', 'Unsupported .cube directive')
    dataStarted = true
    rows.push(triple(line, 'cube row'))
    assertDomain(rows.length <= size ** 3, 'INVALID_ARGUMENT', '.cube has too many rows')
  }
  assertDomain(size !== undefined && rows.length === size ** 3, 'INVALID_ARGUMENT', '.cube row count does not match LUT_3D_SIZE')
  assertDomain(domainMin.every((value, index) => value < domainMax[index]!), 'INVALID_ARGUMENT', '.cube domain is invalid')
  const canonicalLines = [
    ...(title ? [`TITLE "${title.replace(/"/g, '\\"')}"`] : []),
    `LUT_3D_SIZE ${size}`,
    `DOMAIN_MIN ${domainMin.map(canonicalNumber).join(' ')}`,
    `DOMAIN_MAX ${domainMax.map(canonicalNumber).join(' ')}`,
    ...rows.map((row) => row.map(canonicalNumber).join(' ')),
  ]
  const canonicalContent = `${canonicalLines.join('\n')}\n`
  const body = Object.freeze({ schemaVersion: 'parsed-cube-3d/v1' as const, ...(title ? { title } : {}), size, domainMin, domainMax, rows: rows.length, canonicalContent })
  return Object.freeze({ ...body, contentHash: calculateCanonicalHash(body) })
}

export function materializeCube3dIntensity(content: string, intensity: number): Readonly<ParsedCube3d> {
  assertDomain(Number.isFinite(intensity) && intensity >= 0 && intensity <= 1, 'INVALID_ARGUMENT', 'intensity must be between 0 and 1')
  const parsed = parseCube3d(content)
  const lines = parsed.canonicalContent.trimEnd().split('\n')
  const firstRow = lines.findIndex((line) => /^[-+]?\d/.test(line))
  assertDomain(firstRow >= 0, 'INVALID_ARGUMENT', '.cube has no data rows')
  const header = lines.slice(0, firstRow)
  const rows = lines.slice(firstRow).map((line) => line.split(/\s+/).map(Number))
  const scaled = rows.map((row, index) => {
    const red = Math.floor(index / (parsed.size * parsed.size)) / (parsed.size - 1)
    const green = Math.floor(index / parsed.size) % parsed.size / (parsed.size - 1)
    const blue = index % parsed.size / (parsed.size - 1)
    const identity = [red, green, blue]
    return row.map((value, channel) => canonicalNumber(identity[channel]! + (value - identity[channel]!) * intensity)).join(' ')
  })
  return parseCube3d(`${[...header, ...scaled].join('\n')}\n`)
}

export function createWorkspaceLutVersion(input: {
  id: string; workspaceId: string; lutId: string; version: number; name: string; owner: string
  license: { policy: LutLicensePolicy; name: string; usageNotes?: string }; tags?: readonly string[]
  compatibility: { inputColorSpace: LutColorSpace; outputColorSpace: LutColorSpace }; intensity?: number
  cubeContent: string; preview: { byteSize: number; sha256: string }; createdByClientId: string; createdAt: string
}): Readonly<WorkspaceLutVersion> {
  assertDomain(Number.isSafeInteger(input.version) && input.version >= 1, 'INVALID_ARGUMENT', 'version is invalid')
  assertDomain(LICENSE_POLICIES.includes(input.license.policy), 'INVALID_ARGUMENT', 'license.policy is invalid')
  assertDomain(COLOR_SPACES.includes(input.compatibility.inputColorSpace) && COLOR_SPACES.includes(input.compatibility.outputColorSpace), 'INVALID_ARGUMENT', 'LUT compatibility is invalid')
  const intensity = input.intensity ?? 1
  assertDomain(Number.isFinite(intensity) && intensity >= 0 && intensity <= 1, 'INVALID_ARGUMENT', 'intensity must be between 0 and 1')
  assertDomain(Number.isSafeInteger(input.preview.byteSize) && input.preview.byteSize > 0 && HASH.test(input.preview.sha256), 'INVALID_ARGUMENT', 'preview identity is invalid')
  const tags = [...new Set((input.tags ?? []).map((tag) => textValue(tag, 'tag', 48).toLocaleLowerCase('en-US')))].sort()
  assertDomain(tags.length <= 20, 'INVALID_ARGUMENT', 'tags exceed the limit')
  const createdAt = new Date(input.createdAt)
  assertDomain(!Number.isNaN(createdAt.getTime()) && createdAt.toISOString() === input.createdAt, 'INVALID_ARGUMENT', 'createdAt is invalid')
  const content = Object.freeze({
    schemaVersion: 'workspace-lut-version/v1' as const,
    id: identity(input.id, 'id'), workspaceId: identity(input.workspaceId, 'workspaceId'), lutId: identity(input.lutId, 'lutId'), version: input.version,
    name: textValue(input.name, 'name', 160), owner: textValue(input.owner, 'owner', 240),
    license: Object.freeze({ policy: input.license.policy, name: textValue(input.license.name, 'license.name', 240), ...(input.license.usageNotes ? { usageNotes: textValue(input.license.usageNotes, 'license.usageNotes', 2000) } : {}) }),
    tags: Object.freeze(tags), compatibility: Object.freeze({ ...input.compatibility }),
    intensity: Object.freeze({ default: intensity, min: 0 as const, max: 1 as const }),
    cube: parseCube3d(input.cubeContent),
    preview: Object.freeze({ mediaType: 'image/png' as const, width: 512 as const, height: 288 as const, byteSize: input.preview.byteSize, sha256: input.preview.sha256 }),
    createdByClientId: identity(input.createdByClientId, 'createdByClientId'), createdAt: input.createdAt,
  })
  return Object.freeze({ ...content, recordHash: calculateCanonicalHash(content) })
}
