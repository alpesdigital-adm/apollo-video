import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import * as importedTranscriberModule from '../src/v2/infrastructure/media/groq-media-transcriber.ts'

const transcriberModule = importedTranscriberModule.createMediaTranscriberFromEnvironment
  ? importedTranscriberModule
  : importedTranscriberModule.default
const audioPath = process.argv[2]?.trim()
const outputPath = process.argv[3]?.trim()
if (!audioPath) throw new Error('Usage: verify-recovery-render <audio-path> [output-json-path]')

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
const forbiddenPhrases = [
  '31 de janeiro',
  'trinta e um de janeiro',
  '1 de fevereiro',
  'primeiro de fevereiro',
  'dois dias',
  '2 dias',
]
const forbiddenMatches = forbiddenPhrases.filter((phrase) => normalized.includes(normalize(phrase)))
const seamContexts = [36.26, 64.72].map((seamSeconds) => ({
  seamSeconds,
  text: transcript.words
    .filter((word) => word.end >= seamSeconds - 3 && word.start <= seamSeconds + 3)
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
