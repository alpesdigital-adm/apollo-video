import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { FORMATS, FRAMING_RULES, faceRectOf, framingOf } from './corpus-geometry.mjs'
import { DEFECT_TABLE, labelsOf, outputSpecOf, presetBands, TIMELINE, VARIANTS, VARIANT_DEFECTS } from './render-world.mjs'

const { MP4_PIXEL_CRITIC_POLICY, MP4_PIXEL_CRITIC_POLICY_SHA256 } = await import('../../../src/v2/domain/mp4-pixel-quality.ts')
const { pixelOracleModelPins } = await import('../../../src/v2/domain/pixel-face-oracle.ts')
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')

/**
 * W67 controlled corpus generator, FREEZE phase. It only reads metadata (the Open Images rows of the V5 manifest, the licence audit, the
 * preset geometry) and writes the manifest, labels and tolerances that must be committed BEFORE the first render. It decodes no pixel,
 * runs no detector and renders nothing. The render and evaluation phases re-derive the same document and refuse to run if it differs.
 */
export const BASE = 'C:/Users/leand/Documents/Apollo/w61-70-20261008'
export const PROTOCOL_ID = 'w67-mp4-critic-preregistration/v1'
const SELECTION_PREFIX = 'w67-mp4-v1|select|'
const OPEN_IMAGES_FACE = '/m/0dzct'
const HUMAN_SOURCES = ['xclick', 'activemil']

export const sha256Text = (text) => createHash('sha256').update(text).digest('hex')
export const sha256Bytes = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const roundTrip = (value) => JSON.parse(JSON.stringify(value))

/** Files whose bytes define the oracle, the critic, the generator and the evaluator; the run refuses to start if any of them changed. */
export const FROZEN_CODE = Object.freeze([
  'src/v2/domain/mp4-pixel-quality.ts', 'src/v2/domain/mp4-pixel-geometry.ts', 'src/v2/domain/pixel-face-oracle.ts',
  'src/v2/domain/face-detector-output.ts',
  'src/v2/infrastructure/media/ffmpeg-mp4-pixel-critic.ts', 'src/v2/infrastructure/perception/openvino-pixel-oracle.ts',
  'src/v2/infrastructure/perception/openvino_pixel_oracle_bridge.py',
  'tests/v2/w67/corpus-geometry.mjs', 'tests/v2/w67/render-world.mjs', 'tests/v2/w67/corpus-generate.mjs', 'tests/v2/w67/corpus-evaluate.mjs',
  'tests/v2/w67/corpus-run.mjs', 'tests/v2/w67/oracle-config.mjs',
])

export function codeHashes(repositoryRoot) {
  return Object.fromEntries(FROZEN_CODE.map((path) => [path, sha256Bytes(resolve(repositoryRoot, path))]))
}

/** The rows of the manifest, with the selection rule applied. Pure metadata. */
export async function candidateTable({ items, visualExclusions }) {
  const rows = []
  const bandsByFormat = {}
  for (const format of Object.keys(FORMATS)) bandsByFormat[format] = await presetBands(format, { width: 1024, height: 768 })
  for (const item of items) {
    const reasons = []
    const license = item.metadata?.License ?? ''
    if (item.status !== 'eligible' || item.rights !== 'original_landing_confirmed') reasons.push('R1:rights-or-status')
    if (!/creativecommons\.org\/licenses\/by\/(2\.0|4\.0)\//.test(license)) reasons.push('R1:licence-not-cc-by-2.0-or-4.0')
    const boxes = item.boxes ?? []
    const one = boxes.length === 1 && boxes[0].LabelName === OPEN_IMAGES_FACE && HUMAN_SOURCES.includes(boxes[0].Source)
    if (!one) reasons.push(boxes.length === 0 ? 'R2:no-human-face-box' : boxes.length > 1 ? 'R2:more-than-one-annotated-box' : 'R2:box-not-a-human-face-from-a-human-source')
    else if (['IsOccluded', 'IsTruncated', 'IsGroupOf', 'IsDepiction'].some((flag) => boxes[0][flag] !== '0')) reasons.push('R2:box-flagged-occluded-truncated-group-or-depiction')
    if (item.mirrorWidth % 2 !== 0 || item.mirrorHeight % 2 !== 0) reasons.push('R3:odd-dimension')
    if (item.mirrorExifOrientation !== null || item.metadata?.Rotation !== '0.0') reasons.push('R3:exif-or-rotation')
    const feasibility = {}
    if (!reasons.some((reason) => reason.startsWith('R2')) && reasons.every((reason) => !reason.startsWith('R3'))) {
      const face = faceRectOf(boxes[0])
      for (const format of Object.keys(FORMATS)) {
        const framing = framingOf(face, format, { width: item.mirrorWidth, height: item.mirrorHeight }, bandsByFormat[format])
        feasibility[format] = framing.feasible ? 'feasible' : `${framing.stage}:${framing.reason}`
        if (!framing.feasible) reasons.push(`R4:${format}:${framing.stage}:${framing.reason}`)
      }
    }
    const exclusion = visualExclusions.find((entry) => entry.id === item.id)
    if (exclusion) reasons.push(`R6:visual-exclusion:${exclusion.code}`)
    rows.push({ id: item.id, stratum: item.stratum, eligible: reasons.length === 0, reasons, feasibility, rankKey: sha256Text(`${SELECTION_PREFIX}${item.id}`) })
  }
  return rows
}

/** `forcedIds` is for REHEARSALS only (design work on the development split): it bypasses the selection rule and the manifest says so. */
export async function buildFrozenManifest({ repositoryRoot, set, count = 2, visualExclusions, forcedIds = null, now = new Date() }) {
  const manifestPath = `${BASE}/openimages-w61-v5-manifest.json`
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const items = manifest.sets[set].selected
  const table = await candidateTable({ items, visualExclusions })
  const ranked = table.filter((row) => row.eligible).toSorted((a, b) => a.rankKey.localeCompare(b.rankKey) || a.id.localeCompare(b.id))
  const selected = forcedIds ?? ranked.slice(0, count).map((row) => row.id)
  const bands = {}
  for (const format of Object.keys(FORMATS)) bands[format] = await presetBands(format, { width: 1024, height: 768 })
  const images = selected.map((id) => {
    const item = items.find((candidate) => candidate.id === id)
    return {
      id, set, subset: item.sourceSplit, stratum: item.stratum, mirrorSha256: item.mirrorSha256, mirrorBytes: item.mirrorBytes, mirrorWidth: item.mirrorWidth, mirrorHeight: item.mirrorHeight,
      mirrorExifOrientation: item.mirrorExifOrientation, rotation: item.metadata.Rotation, licence: item.metadata.License, author: item.metadata.Author, title: item.metadata.Title,
      landingUrl: item.landingUrl, landingSha256: item.landingSha256, originalLandingLicence: item.originalPageLicense, originalMd5: item.metadata.OriginalMD5,
      humanBoxes: item.boxes.map((row) => ({ ...row, rowSha256: sha256Text(JSON.stringify(row)) })),
      groundTruth: { convention: 'Open Images "Human face" box (visible face), normalized to the image', origin: 'Open Images validation human-drawn boxes (Source xclick/activemil), preserved verbatim', eyes: 'unknown: no eye annotation, eye checks are out of scope and not counted' },
    }
  })
  const outputs = []
  for (const image of images) {
    const item = items.find((candidate) => candidate.id === image.id)
    const face = faceRectOf(item.boxes[0])
    for (const format of Object.keys(FORMATS)) for (const variant of VARIANTS) {
      const spec = outputSpecOf({ imageId: image.id, format, variant, face, source: { width: item.mirrorWidth, height: item.mirrorHeight }, bands: bands[format] })
      const { framing, ...rest } = spec
      outputs.push(roundTrip({
        ...rest, framing: { good: framing.good, lost: framing.lost, target: framing.target, blockers: framing.blockers, covering: framing.covering, intersecting: framing.intersecting },
        labels: labelsOf(spec),
      }))
    }
  }
  const body = {
    schemaVersion: 'w67-mp4-critic-corpus/v1', protocol: PROTOCOL_ID, frozenAtUtc: now.toISOString(),
    purpose: 'Controlled corpus for the independent critic of the delivered MP4 (W67): clean controls and seeded defects, per format.',
    adjudication: { statement: 'open-images-human-boxes, no project adjudication', humanAdjudicator: null, note: 'No project adjudicator exists yet (owner decision pending). Ground truth is the unchanged Open Images human box of each photograph. The visual inspection below was made by the Claude writer agent, an automated step; it is NOT a human adjudication.' },
    selection: {
      source: { manifest: 'BASE/openimages-w61-v5-manifest.json', manifestSha256: sha256Bytes(manifestPath), set, sourceSplit: manifest.sets[set].sourceSplit, candidates: items.length },
      rules: [
        'R1: status eligible, rights original_landing_confirmed, licence CC BY 2.0 or 4.0 (per-photo audit already done in W61 V5)',
        'R2: exactly one annotated box in the image, label Human face, Source xclick or activemil, IsOccluded=IsTruncated=IsGroupOf=IsDepiction=0',
        'R3: mirror width and height even, no EXIF orientation, Rotation 0.0',
        'R4: the framing rules (corpus-geometry.mjs) can frame the face in BOTH formats: good window, lost window, a caption band covering the framed face, a free bottom band',
        'R5: rank ascending by sha256("w67-mp4-v1|select|<ImageID>") and take the first N; no result of any detector, renderer or critic enters the selection',
        'R6: visual exclusion, from the source photograph only: the annotated "face" is a depiction (printed or painted portrait) or other faces are plainly visible and unannotated',
      ],
      count, candidateTable: table, visualExclusions, selectedImageIds: selected, ...(forcedIds ? { forcedIds, rehearsal: 'the selection rule was bypassed: design rehearsal on the development split, not a registered corpus' } : {}),
    },
    independence: {
      holdout: 'The W62 holdout (V5 sets.holdout, Open Images test split) was never opened, listed or read by this work.',
      productDetector: 'The product detector OMZ face-detection-0204 (V9) ran in W62 on the 60 DEVELOPMENT images only (owner-receipt 390d3b28d172015f8ed2cb3d416e38625ce4d4efaca8e1eea52d7a8e58aaa817: 60 ids, all in development, none in calibration or holdout).',
      calibrationUse: 'The calibration split was evaluated in W61 by YuNet (V5, V6) and by face-detection-retail-0004 (V7) with preregistered configurations that were never changed afterwards; the operating points used here (score 0.50) are those preregistered ones. No threshold of this protocol was chosen on calibration pixels.',
      engineering: 'Policy, geometry and generator were designed and rehearsed on synthetic content and on DEVELOPMENT-split photographs before this freeze; see the preregistration document.',
    },
    images, formats: Object.fromEntries(Object.entries(FORMATS).map(([format, canvas]) => [format, { ...canvas, bands: bands[format], outputSpecId: format === '9:16' ? 'preset-9x16' : 'preset-16x9' }])),
    timeline: TIMELINE, framingRules: FRAMING_RULES, defectTable: DEFECT_TABLE, variantDefects: VARIANT_DEFECTS,
    outputs,
    policy: { id: MP4_PIXEL_CRITIC_POLICY.id, sha256: MP4_PIXEL_CRITIC_POLICY_SHA256, body: MP4_PIXEL_CRITIC_POLICY },
    oracle: {
      union: 'every box of omz-face-detection-0204-v9 and omz-face-detection-retail-0004 (not merged), plus the registered projection of the source detections; unknown when no face evidence exists',
      models: pixelOracleModelPins(), registration: MP4_PIXEL_CRITIC_POLICY.registration,
    },
    controls: { perOutput: ['delivered', 'captions-off', 'cta-off', 'overlays-off'], renderer: 'FfmpegEditorialProxyRenderer (the product renderer), proxy canvas of each format' },
    acceptance: {
      unit: 'defect x format x interval',
      zeroFalseSafe: true, recallDefects: 1, precision: 1, unknownSamples: 0, decodeFailures: 0,
      exactLocalization: 'flagged frames of the defect class equal the labelled interval; frames adjacent to it are negatives',
      ifNotMet: 'the face-related checks FAIL and that is the result: no tuning, no relabelling, no new threshold',
    },
    codeHashes: codeHashes(repositoryRoot),
    limits: [
      'Eyes are unknown (no eye annotation): eye detection and eye safety are not evaluated.',
      'Twenty outputs from two photographs are mechanical controls, not a population estimate and not natural video: the source is a held still.',
      'Ground truth completeness (no other face in the photograph) rests on the Open Images validation annotation; it was not adjudicated by a human.',
      'The caption defect uses face evidence handed to the planner (phantom boxes, omitted real face); the defect position is decided here from public preset geometry, the final band is the planner\'s ordinary result and is reported against the label.',
      'Density has no seeded defect: it is measured on every output (false positives only), its recall is not evaluated.',
      'The proxy canvas (540x960 / 960x540) is the delivered MP4 of these outputs.',
    ],
  }
  // the hash covers everything but the freeze time and itself, so the run phases can re-derive the same document later
  return { ...body, manifestHash: calculateCanonicalHash({ ...body, frozenAtUtc: null }) }
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  const [command, set, outPath, exclusionsPath, forced] = process.argv.slice(2)
  if (command !== 'freeze' || !set || !outPath) throw new Error('usage: corpus-generate.mjs freeze <calibration|development> <out.json> [exclusions.json] [forced-ids-comma-separated (rehearsal only)]')
  const exclusions = exclusionsPath ? JSON.parse(readFileSync(exclusionsPath, 'utf8')) : []
  const forcedIds = forced ? forced.split(',').filter(Boolean) : null
  const frozen = await buildFrozenManifest({ repositoryRoot: resolve(import.meta.dirname, '../../..'), set, visualExclusions: exclusions, forcedIds })
  writeFileSync(outPath, `${JSON.stringify(frozen, null, 2)}\n`)
  console.log(JSON.stringify({ outPath, manifestHash: frozen.manifestHash, selected: frozen.selection.selectedImageIds, outputs: frozen.outputs.length }))
}
