import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)
const outputDirectory = resolve(
  'tests/fixtures/contamination',
)
const manifestPath = resolve(
  outputDirectory,
  'contamination-goldens.json',
)
const fontPath = 'C\\:/Windows/Fonts/arial.ttf'
const detector = {
  provider: 'apollo',
  model: 'contamination-golden',
  version: '1.0.0',
}

function drawText({
  text,
  x,
  y,
  fontSize,
  color = 'white',
  box = false,
}) {
  return [
    `drawtext=fontfile='${fontPath}'`,
    `text='${text}'`,
    `x=${x}`,
    `y=${y}`,
    `fontsize=${fontSize}`,
    `fontcolor=${color}`,
    ...(box
      ? [
          'box=1',
          'boxcolor=black@0.8',
          'boxborderw=8',
        ]
      : []),
  ].join(':')
}

const visualBase = [
  'drawbox=x=0:y=0:w=iw:h=ih:color=0x173044:t=fill',
  'drawbox=x=82:y=112:w=156:h=236:color=0x0b1020@0.62:t=fill',
  'drawbox=x=112:y=76:w=96:h=96:color=0xe3a879:t=fill',
  'drawbox=x=133:y=111:w=12:h=8:color=0x151515:t=fill',
  'drawbox=x=175:y=111:w=12:h=8:color=0x151515:t=fill',
  'drawbox=x=145:y=145:w=30:h=5:color=0x824f42:t=fill',
]

const contaminationFilters = {
  'burned-caption': [
    drawText({
      text: 'OFERTA VALIDADA',
      x: '(w-text_w)/2',
      y: 448,
      fontSize: 18,
      box: true,
    }),
  ],
  'logo-watermark': [
    drawText({
      text: 'APOLLO',
      x: 248,
      y: 28,
      fontSize: 14,
      color: 'white@0.72',
    }),
  ],
  music: [
    drawText({
      text: 'MUSICA MIXADA',
      x: '(w-text_w)/2',
      y: 470,
      fontSize: 13,
      color: '0xffd166',
    }),
  ],
  border: [
    'drawbox=x=0:y=0:w=iw:h=40:color=black:t=fill',
    'drawbox=x=0:y=528:w=iw:h=40:color=black:t=fill',
  ],
  overlay: [
    'drawbox=x=88:y=180:w=144:h=270:color=0xc63f4f@0.72:t=fill',
    drawText({
      text: 'PROMO',
      x: '(w-text_w)/2',
      y: 294,
      fontSize: 22,
      color: 'white',
    }),
  ],
}

const observationTemplates = {
  'burned-caption': {
    id: 'observation-burned-caption',
    kind: 'burned-caption',
    rangeMs: [0, 2_000],
    region: {
      x: 0.1,
      y: 0.78,
      width: 0.8,
      height: 0.12,
    },
    confidence: 0.98,
    detector,
    signals: {
      text: 'OFERTA VALIDADA',
      textTrackMatch: 0.99,
      frameCoverage: 1,
      foregroundContrast: 0.94,
    },
  },
  'logo-watermark': {
    id: 'observation-logo-watermark',
    kind: 'logo-watermark',
    rangeMs: [0, 2_000],
    region: {
      x: 0.77,
      y: 0.03,
      width: 0.2,
      height: 0.08,
    },
    confidence: 0.96,
    detector,
    signals: {
      label: 'APOLLO',
      logoMatch: 0.99,
      frameCoverage: 1,
      opacity: 0.72,
    },
  },
  music: {
    id: 'observation-music',
    kind: 'music',
    rangeMs: [0, 2_000],
    region: null,
    confidence: 0.97,
    detector,
    signals: {
      musicLikelihood: 0.99,
      speechLikelihood: 0.88,
      separableStem: false,
      spectralPersistence: 0.96,
    },
  },
  border: {
    id: 'observation-border',
    kind: 'border',
    rangeMs: [0, 2_000],
    region: {
      x: 0,
      y: 0,
      width: 1,
      height: 0.071,
    },
    confidence: 0.98,
    detector,
    signals: {
      edges: ['top', 'bottom'],
      uniformity: 0.99,
      thicknessRatio: 0.071,
      frameCoverage: 1,
    },
  },
  overlay: {
    id: 'observation-overlay',
    kind: 'overlay',
    rangeMs: [0, 2_000],
    region: {
      x: 0.275,
      y: 0.317,
      width: 0.45,
      height: 0.475,
    },
    confidence: 0.95,
    detector,
    signals: {
      overlayClass: 'promo-card',
      frameCoverage: 1,
      opacity: 0.72,
      occludesSubject: true,
    },
  },
}

const fixtureDefinitions = [
  ...Object.keys(contaminationFilters).map((kind) => ({
    id: `contamination-${kind}`,
    file: `${kind}.mp4`,
    kinds: [kind],
  })),
  {
    id: 'contamination-overlapping-combination',
    file: 'overlapping-combination.mp4',
    kinds: [
      'burned-caption',
      'logo-watermark',
      'music',
      'border',
      'overlay',
    ],
  },
]

await mkdir(outputDirectory, { recursive: true })
const fixtures = []
for (const definition of fixtureDefinitions) {
  const outputPath = resolve(outputDirectory, definition.file)
  const filters = [
    ...visualBase,
    ...definition.kinds.flatMap((kind) =>
      contaminationFilters[kind]),
    drawText({
      text: definition.kinds.length === 1
        ? definition.kinds[0].toUpperCase()
        : 'OVERLAPPING CONTAMINATION',
      x: '(w-text_w)/2',
      y: 520,
      fontSize: 11,
      color: '0x8cd7ff',
    }),
  ]
  const hasMusic = definition.kinds.includes('music')
  await execFileAsync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x568:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      hasMusic
        ? 'sine=frequency=440:sample_rate=48000:duration=2'
        : 'anullsrc=r=48000:cl=mono:d=2',
      '-vf',
      filters.join(','),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      '-metadata',
      `title=Apollo ${definition.id}`,
      '-metadata',
      'comment=Deterministic F2.016 contamination fixture',
      outputPath,
    ],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  )
  const bytes = await readFile(outputPath)
  fixtures.push({
    ...definition,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    technical: {
      width: 320,
      height: 568,
      fps: 30,
      durationMs: 2_000,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 48_000,
    },
    observations: definition.kinds.map((kind) => ({
      ...structuredClone(observationTemplates[kind]),
      id: definition.kinds.length === 1
        ? observationTemplates[kind].id
        : `overlap-${observationTemplates[kind].id}`,
    })),
    protectedRegions: [{
      id: 'protected-speaker-face',
      kind: 'face',
      rangeMs: [0, 2_000],
      region: {
        x: 0.3,
        y: 0.18,
        width: 0.4,
        height: 0.5,
      },
      confidence: 0.99,
      source: 'fixture-face-detector/v1',
    }],
  })
}

await writeFile(
  manifestPath,
  `${JSON.stringify({
    schemaVersion: 'contamination-golden-fixtures/v1',
    generator: 'scripts/generate-contamination-goldens.mjs',
    fixtures,
  }, null, 2)}\n`,
  'utf8',
)

process.stdout.write(`${manifestPath}\n`)
