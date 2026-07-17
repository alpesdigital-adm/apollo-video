import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateMediaProbe, sniffMediaInput, updateResumableTransfer } from '../../src/v2/domain/media-input.ts'

const bytes = (...values) => Uint8Array.from(values)
const ftyp = (brand) => Uint8Array.from([0,0,0,20, ...Buffer.from('ftyp'), ...Buffer.from(brand)])

test('video, audio and image signatures are sniffed then become usable only after probe', () => {
  const fixtures = [
    { filename: 'clip.mp4', mime: 'video/mp4', data: ftyp('isom'), probe: { codec: 'h264', duration: 30 } },
    { filename: 'fala.wav', mime: 'audio/wav', data: Uint8Array.from([...Buffer.from('RIFF'),0,0,0,0,...Buffer.from('WAVE')]), probe: { codec: 'pcm_s16le', duration: 12 } },
    { filename: 'foto.png', mime: 'image/png', data: bytes(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a), probe: { codec: 'png', width: 1080, height: 1350 } },
  ]
  for (const fixture of fixtures) {
    const media = sniffMediaInput({ filename: fixture.filename, declaredMime: fixture.mime, bytes: fixture.data, byteSize: fixture.data.length })
    assert.equal(evaluateMediaProbe(media, fixture.probe).status, 'usable')
  }
})

test('codec, corruption, extension and duration failures are actionable and quarantined', () => {
  const video = sniffMediaInput({ filename: 'clip.mp4', declaredMime: 'video/mp4', bytes: ftyp('isom'), byteSize: 20 })
  const codec = evaluateMediaProbe(video, { codec: 'prores', duration: 10 })
  assert.equal(codec.status, 'quarantined')
  assert.equal(codec.error.code, 'UNSUPPORTED_CODEC')
  assert.ok(codec.error.action.length > 20)
  assert.throws(() => sniffMediaInput({ filename: 'fake.png', declaredMime: 'image/png', bytes: bytes(1,2,3), byteSize: 3 }), /unsupported or file is corrupted/)
  assert.throws(() => sniffMediaInput({ filename: 'fake.jpg', declaredMime: 'video/mp4', bytes: ftyp('isom'), byteSize: 20 }), /extension does not match/)
  assert.equal(evaluateMediaProbe(video, { codec: 'h264', duration: 20_000 }).error.code, 'INVALID_DURATION')
})

test('multipart progress pauses on network failure, resumes missing parts and cancels terminally', () => {
  let state = { totalBytes: 30, uploadedBytes: 0, completedParts: [], status: 'uploading' }
  state = updateResumableTransfer(state, { type: 'part-completed', partNumber: 1, byteSize: 10 })
  state = updateResumableTransfer(state, { type: 'network-failed', message: 'offline' })
  assert.equal(state.status, 'paused')
  state = updateResumableTransfer(state, { type: 'resume' })
  state = updateResumableTransfer(state, { type: 'part-completed', partNumber: 2, byteSize: 10 })
  state = updateResumableTransfer(state, { type: 'part-completed', partNumber: 3, byteSize: 10 })
  assert.equal(state.status, 'completed')
  assert.equal(state.uploadedBytes, 30)
  const canceled = updateResumableTransfer({ totalBytes: 30, uploadedBytes: 10, completedParts: [1], status: 'paused' }, { type: 'cancel' })
  assert.equal(canceled.status, 'canceled')
})
