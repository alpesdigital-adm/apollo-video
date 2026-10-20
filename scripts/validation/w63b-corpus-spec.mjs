import { createHash } from 'node:crypto'

/**
 * W63b corpus specification: the PARAMETERS from which the independent label generator renders every clip and from which every
 * label is written. Nothing here reads a producer's output, and nothing here was chosen after seeing one: the clip list, the
 * strings, the geometries and the frame numbers are functions of (split, clip id) only.
 *
 * Conventions (they are part of the pre-registration):
 *  - every clip is 1920x1080, 30 fps constant frame rate, frame indices are 0-based SOURCE frames;
 *  - a hard cut at frame c means frame c is the first frame of the new shot (the adjacent pair c-1 -> c carries the change);
 *  - a pair p is frame p -> frame p+1; pair ranges are half-open [startPair, endPair);
 *  - a crossfade [startFrame, endFrame) is the ramp of the xfade filter: frame startFrame is the pure outgoing scene, the
 *    pairs startFrame .. endFrame-1 carry the ramp, frame endFrame is the pure incoming scene;
 *  - motion labels give the CONTENT displacement in source pixels per frame (dx > 0: content moves right, dy > 0: content
 *    moves down), which is how the temporal analyzer reports a vector (current(x) = previous(x - dx));
 *  - text, insert and face boxes are tight ink/overlay boxes in source pixels, measured by the generator from its own render.
 */
export const CORPUS_SPEC_VERSION = 'w63b-corpus-spec/v1'
export const VIDEO = Object.freeze({ width: 1920, height: 1080, fps: 30 })
export const SPLITS = Object.freeze(['development', 'evaluation'])
export const OCR_SAMPLE_INTERVAL_FRAMES = 15
/** The temporal analysis grid is 160x90, so one grid pixel is 12 source pixels at 1920x1080. */
export const GRID_QUANTUM_PX = VIDEO.width / 160

export function sha256Hex(value) { return createHash('sha256').update(value).digest('hex') }

export function clipSeed(split, clipId) {
  return Number.parseInt(sha256Hex(`w63b/${split}/${clipId}`).slice(0, 8), 16) >>> 0
}

export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rng, values) => values[Math.floor(rng() * values.length)]
const between = (rng, low, high) => low + Math.floor(rng() * (high - low + 1))
function shuffled(rng, values) {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

/** Disjoint pools per split. Each string is at most 34 characters so a line fits at the largest font in use. */
export const TEXT_POOLS = Object.freeze({
  development: Object.freeze({
    por: Object.freeze([
      'Ação imediata no seu negócio', 'Última chance de inscrição', 'Você já conhece o método?', 'Coração de dono, cabeça fria',
      'Atenção: vagas limitadas hoje', 'Preço promocional até sexta', 'Informação importante do curso', 'Educação financeira prática',
      'Condições especiais de pagamento', 'Gestão de pessoas e resultados', 'Oportunidade única para você', 'Relatório mensal já disponível',
    ]),
    eng: Object.freeze([
      'Free lesson starts today', 'Limited seats available now', 'Learn the method step by step', 'Join the next live session',
      'Your results start here', 'Download the complete guide', 'Watch the full training', 'Reserve your spot before Friday',
    ]),
    num: Object.freeze(['R$ 1.299,90 em 12x', 'Aula 03 de 10 - 45 min', '50% de desconto até 31/12']),
  }),
  evaluation: Object.freeze({
    por: Object.freeze([
      'Ação e resultado no mesmo dia', 'Última turma do ano começa já', 'Você pode começar agora mesmo', 'Sem cartão de crédito agora',
      'Atenção aos prazos de entrega', 'Preço justo, sem pegadinha', 'Inscrição aberta até domingo', 'Seleção rigorosa de mentores',
      'Cálculo rápido de comissões', 'Tributação simples explicada', 'Não perca esta oportunidade', 'Orientação passo a passo',
    ]),
    eng: Object.freeze([
      'New class opens next Monday', 'Only a few places remain', 'Build a business that lasts', 'Get the checklist for free',
      'Meet the team behind the course', 'Practical lessons every week', 'Book your session today', 'Start small and grow steady',
    ]),
    num: Object.freeze(['R$ 497,00 à vista', 'Módulo 07 de 12 - 38 min', '30% off até 15/01']),
  }),
})

export const THEMES = Object.freeze({
  dark: Object.freeze({ id: 'dark', background: '0x101820', text: '0xFFFFFF', inkLuma: 'bright' }),
  light: Object.freeze({ id: 'light', background: '0xF2F2F2', text: '0x101010', inkLuma: 'dark' }),
})

const SLOT_TOP = 140
const SLOT_PITCH = 230
const START_CHOICES = Object.freeze([0, 15, 30, 45, 60, 75])
const LENGTH_CHOICES = Object.freeze([60, 75, 90, 105, 120, 150])

function textLines(rng, split, mixture, count, capHeightPx, frames) {
  const pools = TEXT_POOLS[split]
  const candidates = []
  for (const [language, share] of mixture) {
    const pool = shuffled(rng, pools[language])
    for (let index = 0; index < share; index += 1) candidates.push({ text: pool[index % pool.length], language })
  }
  const chosen = shuffled(rng, candidates).slice(0, count)
  return chosen.map((entry, slot) => {
    const startFrame = pick(rng, START_CHOICES)
    const endFrame = Math.min(frames, startFrame + pick(rng, LENGTH_CHOICES))
    return { id: `line-${slot + 1}`, text: entry.text, language: entry.language === 'num' ? 'por' : entry.language,
      capHeightPx, startFrame, endFrame, x: pick(rng, [96, 144, 192, 240]), y: SLOT_TOP + slot * SLOT_PITCH, boxPx: null }
  })
}

const flat = (color, frames) => ({ type: 'flat', color, frames })
const texture = (seed, frames, extra = {}) => ({ type: 'texture', seed, frames, bias: 0, drift: null, ...extra })

function baseClip(split, id, stratum, extra) {
  return { id, stratum, frames: 180, seed: clipSeed(split, id), audio: null, scenes: [], transitions: [], overlays: { inserts: [], head: null },
    text: [], textBox: false, theme: null, editPlan: null, labels: { hardCuts: [], crossfades: [], motion: [], inserts: [], faces: [], audio: [] },
    evaluation: {}, ...extra }
}

function textClip(split, id, stratum, { theme, capHeightPx, mixture, background = 'solid', count = 4 }) {
  const rng = mulberry32(clipSeed(split, id))
  const clip = baseClip(split, id, stratum, { theme: THEMES[theme].id })
  clip.text = textLines(rng, split, mixture, count, capHeightPx, clip.frames)
  if (background === 'texture') {
    clip.scenes = [texture(clipSeed(split, `${id}/scene0`), clip.frames, { bias: -0.2 })]
    clip.textBox = true
  } else clip.scenes = [flat(THEMES[theme].background, clip.frames)]
  clip.labels.motion = [{ startPair: 0, endPair: clip.frames - 1, dxPxPerFrame: 0, dyPxPerFrame: 0 }]
  return clip
}

function cutFrames(rng, total = 3) {
  const frames = []
  let at = between(rng, 24, 48)
  for (let index = 0; index < total; index += 1) {
    frames.push(at)
    at += between(rng, 30, 48)
  }
  return { frames, length: at + between(rng, 24, 40) }
}

function sceneBounds(cuts, length) {
  const edges = [0, ...cuts, length]
  return edges.slice(0, -1).map((start, index) => [start, edges[index + 1]])
}

function hardCutClip(split, id, stratum, { kind, startsWhite = false, contrast = 0 }) {
  const rng = mulberry32(clipSeed(split, id))
  const { frames: cuts, length } = cutFrames(rng)
  const bounds = sceneBounds(cuts, length)
  const clip = baseClip(split, id, stratum, { frames: length })
  clip.scenes = bounds.map(([start, end], index) => {
    const frames = end - start
    if (kind === 'flat') return flat(((index % 2 === 0) !== startsWhite) ? '0x000000' : '0xFFFFFF', frames)
    return texture(clipSeed(split, `${id}/scene${index}`), frames, { bias: contrast ? (index % 2 ? contrast : -contrast) : [-0.1, 0.1, 0][index % 3] })
  })
  clip.transitions = cuts.map(() => ({ type: 'cut' }))
  clip.labels.hardCuts = cuts.map((frame) => ({ frame }))
  // motion is labelled per scene on the pairs fully inside it; the cut pair itself carries the boundary label, not a motion label
  clip.labels.motion = bounds.map(([start, end]) => ({ startPair: start, endPair: end - 1, dxPxPerFrame: 0, dyPxPerFrame: 0 }))
  return clip
}

function crossfadeClip(split, id, stratum, { stable, fades, scenes }) {
  const clip = baseClip(split, id, stratum)
  const lengths = stable.map((value, index) => value + (index > 0 ? fades[index - 1] : 0) + (index < fades.length ? fades[index] : 0))
  clip.scenes = scenes.map((scene, index) => scene.type === 'flat' ? flat(scene.color, lengths[index])
    : texture(clipSeed(split, `${id}/scene${index}`), lengths[index], { bias: scene.bias ?? 0 }))
  clip.transitions = fades.map((frames) => ({ type: 'xfade', frames }))
  clip.frames = stable.reduce((sum, value) => sum + value, 0) + fades.reduce((sum, value) => sum + value, 0)
  let start = 0
  clip.labels.crossfades = fades.map((frames, index) => {
    start += stable[index] + (index > 0 ? fades[index - 1] : 0)
    return { startFrame: start, endFrame: start + frames }
  })
  // motion is labelled only on the stable stretches (a crossfade has no global translation)
  const motion = []
  let cursor = 0
  clip.labels.crossfades.forEach((fade) => {
    if (fade.startFrame - 1 > cursor) motion.push({ startPair: cursor, endPair: fade.startFrame, dxPxPerFrame: 0, dyPxPerFrame: 0 })
    cursor = fade.endFrame + 1
  })
  if (clip.frames - 1 > cursor) motion.push({ startPair: cursor, endPair: clip.frames - 1, dxPxPerFrame: 0, dyPxPerFrame: 0 })
  clip.labels.motion = motion
  return clip
}

function panClip(split, id, stratum, { dx, dy }) {
  const clip = baseClip(split, id, stratum, { frames: 120 })
  clip.scenes = [texture(clipSeed(split, `${id}/scene0`), 120, { pan: { startFrame: 30, dxPxPerFrame: dx, dyPxPerFrame: dy } })]
  clip.labels.motion = [
    { startPair: 0, endPair: 30, dxPxPerFrame: 0, dyPxPerFrame: 0 },
    { startPair: 30, endPair: 119, dxPxPerFrame: dx, dyPxPerFrame: dy },
  ]
  return clip
}

function insertClip(split, id, stratum) {
  const rng = mulberry32(clipSeed(split, id))
  const clip = baseClip(split, id, stratum, { frames: 150 })
  clip.scenes = [texture(clipSeed(split, `${id}/scene0`), 150, { bias: 0 })]
  const specs = [[1280, 720], [480, 270]]
  const slots = [[24, 60], [78, 126]]
  clip.overlays.inserts = specs.map(([width, height], index) => {
    const [from, to] = slots[index]
    const startFrame = between(rng, from, from + 12)
    const endFrame = between(rng, to - 12, to)
    const x = 8 * between(rng, 4, Math.floor((VIDEO.width - width) / 8) - 4)
    const y = 8 * between(rng, 4, Math.floor((VIDEO.height - height) / 8) - 4)
    return { id: `insert-${index + 1}`, imageSeed: clipSeed(split, `${id}/insert${index + 1}`), startFrame, endFrame, boxPx: [x, y, width, height] }
  })
  clip.labels.inserts = clip.overlays.inserts.map((insert) => ({ id: insert.id, startFrame: insert.startFrame, endFrame: insert.endFrame, boxPx: insert.boxPx }))
  clip.labels.motion = [{ startPair: 0, endPair: 149, dxPxPerFrame: 0, dyPxPerFrame: 0 }]
  return clip
}

function audioProgram(rng, frames, bursts) {
  const seconds = frames / VIDEO.fps
  const intervals = []
  let cursor = 0.4
  for (let index = 0; index < bursts; index += 1) {
    const length = 0.6 + Math.floor(rng() * 8) / 10
    if (cursor + length > seconds - 0.2) break
    intervals.push({ startSec: Number(cursor.toFixed(3)), endSec: Number((cursor + length).toFixed(3)), kind: 'tone-burst', hz: pick(rng, [330, 440, 523]) })
    cursor += length + 0.4
  }
  return intervals
}

function talkingClip(split, id, stratum, { background, lowerThird }) {
  const rng = mulberry32(clipSeed(split, id))
  const clip = baseClip(split, id, stratum, { frames: 150, theme: 'dark' })
  clip.scenes = [flat(background, 150)]
  clip.overlays.head = { width: 500, height: 620, x: 710, y: 190, swayPx: 6, swayPeriodFrames: 56, mouthPeriodFrames: 12 }
  const intervals = audioProgram(rng, 150, 3)
  clip.audio = { intervals }
  clip.labels.audio = intervals
  clip.labels.faces = [{ kind: 'synthetic-face-like-shape', startFrame: 0, endFrame: 150,
    boxPx: [710 - 6, 190, 500 + 12, 620], note: 'drawn ellipse with eyes and a mouth; NOT a photographic face' }]
  clip.text = [{ id: 'lower-third', text: lowerThird.text, language: lowerThird.language, capHeightPx: 36, startFrame: 30, endFrame: 150, x: 120, y: 880, boxPx: null }]
  clip.textBox = true
  clip.labels.motion = [{ startPair: 0, endPair: 149, dxPxPerFrame: 0, dyPxPerFrame: 0 }]
  return clip
}

function audioClip(split, id, stratum) {
  const rng = mulberry32(clipSeed(split, id))
  const clip = baseClip(split, id, stratum, { frames: 150, theme: 'dark' })
  clip.scenes = [texture(clipSeed(split, `${id}/scene0`), 150, { bias: -0.2 })]
  const intervals = audioProgram(rng, 150, 4)
  clip.audio = { intervals }
  clip.labels.audio = intervals
  const lines = textLines(rng, split, [['por', 1], ['eng', 1]], 2, 56, 150)
  clip.text = lines.map((line, index) => ({ ...line, startFrame: index === 0 ? 0 : 30, endFrame: 150 }))
  clip.textBox = true
  clip.labels.motion = [{ startPair: 0, endPair: 149, dxPxPerFrame: 0, dyPxPerFrame: 0 }]
  return clip
}

/** Source 240 frames: scene A [0,90), hard cut, scene B [90,180) whose last 60 frames pan, so the cut and the pan both survive an edit. */
function timeAfterCutsClip(split, id, stratum, { clips }) {
  const rng = mulberry32(clipSeed(split, id))
  const clip = baseClip(split, id, stratum, { frames: 240, theme: 'dark' })
  clip.scenes = [
    texture(clipSeed(split, `${id}/scene0`), 90, { bias: -0.2 }),
    texture(clipSeed(split, `${id}/scene1`), 60, { bias: -0.2 }),
    texture(clipSeed(split, `${id}/scene2`), 90, { bias: -0.2, pan: { startFrame: 30, dxPxPerFrame: -12, dyPxPerFrame: 0 } }),
  ]
  clip.transitions = [{ type: 'cut' }, { type: 'cut' }]
  clip.textBox = true
  const lines = textLines(rng, split, [['por', 3], ['eng', 1]], 3, 56, 240)
  // visible ranges chosen so that one line straddles an edit seam and every line meets a kept clip
  const ranges = [[0, 105], [75, 165], [195, 240]]
  clip.text = lines.map((line, index) => ({ ...line, startFrame: ranges[index][0], endFrame: ranges[index][1], y: SLOT_TOP + index * 300 }))
  clip.labels.hardCuts = [{ frame: 90 }, { frame: 150 }]
  clip.labels.motion = [
    { startPair: 0, endPair: 89, dxPxPerFrame: 0, dyPxPerFrame: 0 },
    { startPair: 90, endPair: 149, dxPxPerFrame: 0, dyPxPerFrame: 0 },
    { startPair: 150, endPair: 180, dxPxPerFrame: 0, dyPxPerFrame: 0 },
    { startPair: 180, endPair: 239, dxPxPerFrame: -12, dyPxPerFrame: 0 },
  ]
  let cursor = 0
  clip.editPlan = { clips: clips.map(([sourceIn, sourceOut], index) => {
    const entry = { id: `clip-${index + 1}`, sourceInFrame: sourceIn, sourceOutFrame: sourceOut, timelineInFrame: cursor, timelineOutFrame: cursor + (sourceOut - sourceIn) }
    cursor += sourceOut - sourceIn
    return entry
  }), durationFrames: cursor }
  return clip
}

function ptsGapClip(split, id, stratum) {
  const clip = baseClip(split, id, stratum, { frames: 60 })
  clip.scenes = [texture(clipSeed(split, `${id}/scene0`), 60)]
  clip.labels.motion = [{ startPair: 0, endPair: 59, dxPxPerFrame: 0, dyPxPerFrame: 0 }]
  clip.evaluation = { ptsGapAtFrame: 20, ptsGapSeconds: 0.5 }
  return clip
}

export const UNRUN = Object.freeze([
  { stratum: 'text-non-latin', status: 'unrun', reason: 'Tesseract traineddata is present locally only for eng and por, and the product restricts OCR languages to por/eng (createPerceptionProducerWorker); a non-Latin script cannot be produced, so no label is generated for it.' },
  { stratum: 'talking-head-real-face', status: 'unrun', reason: 'The only private face corpus on this machine is admitted for a decode-and-resize-to-448x448 development benchmark (rights-admission-single-output-v2.json, scope development-benchmark, entries expired 2026-10-14T13:38Z); compositing a photograph into a test clip is outside that scope. The talking-head stratum therefore uses a drawn face-like shape and is labelled synthetic.' },
  { stratum: 'face-producer', status: 'unrun', reason: 'W63b evaluates OCR and the temporal (shot/motion) producers; the face producer needs real faces and its own admission and is not evaluated here.' },
])

/** The full clip list of a split. The same recipe is used for both splits; only seeds and text pools differ. */
export function buildCorpusSpec(split) {
  if (!SPLITS.includes(split)) throw new Error(`unknown split ${split}`)
  const clips = [
    textClip(split, 'text-normal-a', 'text-normal', { theme: 'dark', capHeightPx: 56, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-normal-b', 'text-normal', { theme: 'light', capHeightPx: 56, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-normal-c', 'text-normal', { theme: 'dark', capHeightPx: 56, mixture: [['por', 2], ['eng', 2]], background: 'texture' }),
    textClip(split, 'text-small-20-a', 'text-small-20', { theme: 'dark', capHeightPx: 20, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-small-20-b', 'text-small-20', { theme: 'light', capHeightPx: 20, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-small-16-a', 'text-small-16', { theme: 'dark', capHeightPx: 16, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-small-16-b', 'text-small-16', { theme: 'light', capHeightPx: 16, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-small-12-a', 'text-small-12', { theme: 'dark', capHeightPx: 12, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-small-12-b', 'text-small-12', { theme: 'light', capHeightPx: 12, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-multilingual-a', 'text-multilingual', { theme: 'dark', capHeightPx: 36, mixture: [['por', 4]] }),
    textClip(split, 'text-multilingual-b', 'text-multilingual', { theme: 'light', capHeightPx: 36, mixture: [['por', 2], ['eng', 2]] }),
    textClip(split, 'text-multilingual-c', 'text-multilingual', { theme: 'dark', capHeightPx: 36, mixture: [['num', 2], ['por', 1], ['eng', 1]] }),
    baseClip(split, 'static-a', 'static', { frames: 120, scenes: [texture(clipSeed(split, 'static-a/scene0'), 120)],
      labels: { hardCuts: [], crossfades: [], motion: [{ startPair: 0, endPair: 119, dxPxPerFrame: 0, dyPxPerFrame: 0 }], inserts: [], faces: [], audio: [] } }),
    hardCutClip(split, 'hard-cut-high-contrast-a', 'hard-cut-high-contrast', { kind: 'flat' }),
    hardCutClip(split, 'hard-cut-high-contrast-b', 'hard-cut-high-contrast', { kind: 'flat', startsWhite: true }),
    hardCutClip(split, 'hard-cut-textured-a', 'hard-cut-textured', { kind: 'texture' }),
    hardCutClip(split, 'hard-cut-textured-b', 'hard-cut-textured', { kind: 'texture', contrast: 0.15 }),
    crossfadeClip(split, 'crossfade-high-contrast-a', 'crossfade-high-contrast', { stable: [30, 40, 30], fades: [12, 20],
      scenes: [{ type: 'flat', color: '0x000000' }, { type: 'texture', bias: 0 }, { type: 'flat', color: '0xFFFFFF' }] }),
    crossfadeClip(split, 'crossfade-high-contrast-b', 'crossfade-high-contrast', { stable: [30, 36, 30], fades: [16, 12],
      scenes: [{ type: 'flat', color: '0xFFFFFF' }, { type: 'texture', bias: 0.05 }, { type: 'flat', color: '0x000000' }] }),
    crossfadeClip(split, 'crossfade-low-contrast-a', 'crossfade-low-contrast', { stable: [30, 30, 30], fades: [20, 20],
      scenes: [{ type: 'texture', bias: 0 }, { type: 'texture', bias: 0.05 }, { type: 'texture', bias: -0.05 }] }),
    panClip(split, 'pan-subquantum-a', 'pan-subquantum', { dx: -4, dy: 0 }),
    panClip(split, 'pan-slow-a', 'pan-slow', { dx: -12, dy: 0 }),
    panClip(split, 'pan-slow-b', 'pan-slow', { dx: 12, dy: 0 }),
    panClip(split, 'pan-fast-a', 'pan-fast', { dx: -36, dy: 0 }),
    panClip(split, 'pan-fast-b', 'pan-fast', { dx: 0, dy: 36 }),
    insertClip(split, 'inserted-image-a', 'inserted-image'),
    insertClip(split, 'inserted-image-b', 'inserted-image'),
    talkingClip(split, 'talking-head-synthetic-a', 'talking-head-synthetic', { background: '0x2B3A4A', lowerThird: { text: split === 'development' ? 'Marina Souza - Diretora' : 'Rafael Lima - Fundador', language: 'por' } }),
    talkingClip(split, 'talking-head-synthetic-b', 'talking-head-synthetic', { background: '0x4A3B2B', lowerThird: { text: split === 'development' ? 'Carlos Pinto - Contador' : 'Helena Costa - Mentora', language: 'por' } }),
    audioClip(split, 'audio-no-face-a', 'audio-no-face'),
    timeAfterCutsClip(split, 'time-after-cuts-a', 'time-after-cuts', { clips: [[30, 120], [150, 225]] }),
    timeAfterCutsClip(split, 'time-after-cuts-reordered-b', 'time-after-cuts', { clips: [[150, 225], [30, 120]] }),
    ptsGapClip(split, 'robustness-pts-gap-a', 'robustness-pts-gap'),
  ]
  const ids = clips.map((clip) => clip.id)
  if (new Set(ids).size !== ids.length) throw new Error('duplicate clip id')
  return Object.freeze({ specVersion: CORPUS_SPEC_VERSION, split, video: VIDEO, ocrSampleIntervalFrames: OCR_SAMPLE_INTERVAL_FRAMES,
    clips, unrun: UNRUN })
}

/** SHA-256 of the canonical (sorted-key) JSON of a value. */
export function canonicalSha256(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    if (item && typeof item === 'object') return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`
    return JSON.stringify(item)
  }
  return sha256Hex(canonical(value))
}
