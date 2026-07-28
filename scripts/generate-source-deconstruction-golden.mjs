import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)
const outputPath = resolve(
  'tests/fixtures/source-deconstruction/reel-published-golden.mp4',
)
const fontPath = 'C\\:/Windows/Fonts/arial.ttf'

const phases = [
  {
    range: [0, 0.9],
    background: '18233f',
    label: 'ABERTURA PUBLICADA',
    caption: 'Antes de comecar, deixa eu me apresentar.',
  },
  {
    range: [0.9, 2.3],
    background: '153a4d',
    label: 'HOOK VALIDADO',
    caption: 'Se o anuncio nao prende atencao.',
  },
  {
    range: [2.3, 4],
    background: '3a2446',
    label: 'CORPO ANTERIOR',
    caption: 'Tres formas de estruturar a mensagem.',
  },
  {
    range: [4, 5.1],
    background: '4b3020',
    label: 'CTA ANTERIOR',
    caption: 'Clique no link e entre para a aula.',
  },
  {
    range: [5.1, 6.2],
    background: '35222a',
    label: 'CAUDA REMOVIVEL',
    caption: 'Um abraco e ate a proxima.',
  },
]

function escapeDrawText(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
}

function drawText({
  text,
  x,
  y,
  fontSize,
  color = 'white',
  enable,
  box = false,
}) {
  return [
    `drawtext=fontfile='${fontPath}'`,
    `text='${escapeDrawText(text)}'`,
    `x=${x}`,
    `y=${y}`,
    `fontsize=${fontSize}`,
    `fontcolor=${color}`,
    ...(box
      ? [
          'box=1',
          'boxcolor=black@0.82',
          'boxborderw=10',
        ]
      : []),
    ...(enable ? [`enable='${enable}'`] : []),
  ].join(':')
}

const filters = [
  ...phases.map(({ range, background }) =>
    [
      'drawbox=x=0',
      'y=0',
      'w=iw',
      'h=ih',
      `color=0x${background}`,
      't=fill',
      `enable='between(t,${range[0]},${range[1]})'`,
    ].join(':')),
  'drawbox=x=82:y=112:w=156:h=236:color=0x0b1020@0.62:t=fill',
  'drawbox=x=112:y=76:w=96:h=96:color=0xe3a879:t=fill',
  'drawbox=x=133:y=111:w=12:h=8:color=0x151515:t=fill',
  'drawbox=x=175:y=111:w=12:h=8:color=0x151515:t=fill',
  'drawbox=x=145:y=145:w=30:h=5:color=0x824f42:t=fill',
  drawText({
    text: 'REEL PUBLICADO',
    x: '(w-text_w)/2',
    y: 26,
    fontSize: 14,
    color: 'white@0.72',
  }),
  ...phases.flatMap(({ range, label, caption }) => {
    const enable = `between(t,${range[0]},${range[1]})`
    return [
      drawText({
        text: label,
        x: '(w-text_w)/2',
        y: 52,
        fontSize: 20,
        color: 'white',
        enable,
      }),
      drawText({
        text: caption,
        x: '(w-text_w)/2',
        y: 438,
        fontSize: 12,
        color: 'white',
        enable,
        box: true,
      }),
    ]
  }),
  drawText({
    text: 'LEGENDA QUEIMADA',
    x: '(w-text_w)/2',
    y: 500,
    fontSize: 11,
    color: '0xffd166',
  }),
]

await mkdir(dirname(outputPath), { recursive: true })
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
    'color=c=black:s=320x568:r=30:d=6.2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=6.2',
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
    'title=Apollo source deconstruction golden reel',
    '-metadata',
    'comment=Deterministic F2.015 audiovisual regression fixture',
    outputPath,
  ],
  { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
)

process.stdout.write(`${outputPath}\n`)
