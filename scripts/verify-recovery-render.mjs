import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import * as importedTranscriberModule from '../src/v2/infrastructure/media/groq-media-transcriber.ts'

const USAGE = `Usage: verify-recovery-render <audio-path> --forbidden-phrases <phrases.json> [--seam-seconds <seconds.json>] [--output <report.json>]

  <audio-path>                the rendered audio to transcribe and check
  --forbidden-phrases <file>  REQUIRED. JSON array of the phrases the project asked to remove (no defaults: the Apollo works from each video's own request)
  --seam-seconds <file>       optional JSON array of cut-seam times (seconds) whose surrounding words are reported
  --output <file>             optional path for the JSON report`

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`)
  process.exit(64)
}

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      'forbidden-phrases': { type: 'string' },
      'seam-seconds': { type: 'string' },
      output: { type: 'string' },
    },
  })
} catch (error) {
  usageError(error instanceof Error ? error.message : String(error))
}
const audioPath = parsed.positionals[0]?.trim()
const outputPath = (parsed.values.output ?? parsed.positionals[1])?.trim()
if (!audioPath) usageError('Missing <audio-path>.')
if (parsed.positionals.length > 2) usageError('Too many positional arguments.')

async function readJsonList(path, flag, accepts) {
  let value
  try {
    value = JSON.parse(await readFile(resolve(path), 'utf8'))
  } catch (error) {
    usageError(`${flag}: cannot read a JSON file at ${path} (${error instanceof Error ? error.message : String(error)}).`)
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(accepts)) {
    usageError(`${flag}: ${path} must be a non-empty JSON array of ${flag === '--forbidden-phrases' ? 'non-empty strings' : 'finite non-negative numbers'}.`)
  }
  return value
}

if (!parsed.values['forbidden-phrases']) usageError('Missing --forbidden-phrases: the phrases to look for come from the request of the video being checked.')
const forbiddenPhrases = await readJsonList(parsed.values['forbidden-phrases'], '--forbidden-phrases',
  (item) => typeof item === 'string' && item.trim().length > 0)
const seamSeconds = parsed.values['seam-seconds']
  ? await readJsonList(parsed.values['seam-seconds'], '--seam-seconds', (item) => Number.isFinite(item) && item >= 0)
  : []

const transcriberModule = importedTranscriberModule.createMediaTranscriberFromEnvironment
  ? importedTranscriberModule
  : importedTranscriberModule.default

const normalize = (value) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()

const transcript = await transcriberModule.createMediaTranscriberFromEnvironment({
  ...process.env,
  TRANSCRIBE_PROVIDER: 'groq',
}).transcribe({
  audioPath: resolve(audioPath),
  language: 'pt-BR',
})
const normalized = normalize(transcript.text)
const forbiddenMatches = forbiddenPhrases.filter((phrase) => normalized.includes(normalize(phrase)))
const seamContexts = seamSeconds.map((seamSecond) => ({
  seamSeconds: seamSecond,
  text: transcript.words
    .filter((word) => word.end >= seamSecond - 3 && word.start <= seamSecond + 3)
    .map((word) => word.word)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim(),
}))
const report = {
  schemaVersion: 'recovery-render-verification/v1',
  provider: transcript.provider,
  model: transcript.model,
  language: transcript.language,
  wordCount: transcript.words.length,
  segmentCount: transcript.segments.length,
  forbiddenMatches,
  forbiddenSpeechAbsent: forbiddenMatches.length === 0,
  seamContexts,
  transcriptText: transcript.text,
}
const serialized = `${JSON.stringify(report, null, 2)}\n`
if (outputPath) await writeFile(resolve(outputPath), serialized, 'utf8')
process.stdout.write(serialized)
if (!report.forbiddenSpeechAbsent) process.exitCode = 2
