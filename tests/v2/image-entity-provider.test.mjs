import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CompositeImageVisionProvider, createConfiguredImageVisionProvider } from '../../src/v2/infrastructure/image/composite-image-vision-provider.ts'
import { GoogleCloudImageVisionProvider } from '../../src/v2/infrastructure/image/google-cloud-image-vision-provider.ts'

const unavailable = (reason, provider = 'fixture') => Object.freeze({
  state: 'unavailable',
  values: Object.freeze([]),
  producer: Object.freeze({ provider, model: 'none', version: 'v1' }),
  reasonCodes: Object.freeze([reason]),
})

async function sourceFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'apollo-image-entity-'))
  const sourcePath = join(root, 'source.png')
  await writeFile(sourcePath, Buffer.from('not-decoded-by-provider-contract'))
  try { return await run(sourcePath) } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('T-FR-047 Google Cloud Vision adapter sends bounded face/object request and normalizes observations', async () => {
  await sourceFixture(async (sourcePath) => {
    let request
    const provider = new GoogleCloudImageVisionProvider({
      apiKey: 'google-cloud-vision-test-key-00001',
      fetchImplementation: async (url, init) => {
        request = { url, init, body: JSON.parse(init.body) }
        return new Response(JSON.stringify({ responses: [{
          faceAnnotations: [{
            detectionConfidence: 0.93,
            boundingPoly: { vertices: [
              { x: 100, y: 50 }, { x: 300, y: 50 },
              { x: 300, y: 250 }, { x: 100, y: 250 },
            ] },
          }],
          localizedObjectAnnotations: [{
            name: 'Microphone', score: 0.87,
            boundingPoly: { normalizedVertices: [
              { x: 0.6, y: 0.3 }, { x: 0.8, y: 0.3 },
              { x: 0.8, y: 0.9 }, { x: 0.6, y: 0.9 },
            ] },
          }],
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const result = await provider.analyze({ sourcePath, width: 1000, height: 500 })
    assert.equal(request.url.startsWith('https://vision.googleapis.com/v1/images:annotate?key='), true)
    assert.equal(request.init.method, 'POST')
    assert.deepEqual(request.body.requests[0].features, [
      { type: 'FACE_DETECTION', maxResults: 50 },
      { type: 'OBJECT_LOCALIZATION', maxResults: 50 },
    ])
    assert.equal(Buffer.from(request.body.requests[0].image.content, 'base64').toString(), 'not-decoded-by-provider-contract')
    assert.equal(result.faces.values[0].label, 'face')
    assert.deepEqual(result.faces.values[0].box, [0.1, 0.1, 0.19999999999999998, 0.4])
    assert.equal(result.faces.values[0].confidence, 0.93)
    assert.equal(result.objects.values[0].label, 'Microphone')
    assert.ok(Math.abs(result.objects.values[0].box[2] - 0.2) < 1e-12)
    assert.ok(Math.abs(result.objects.values[0].box[3] - 0.6) < 1e-12)
    assert.equal(result.objects.values[0].confidence, 0.87)
    assert.deepEqual(result.objects.producer, { provider: 'google-cloud-vision', model: 'object-localization', version: 'v1' })
    assert.deepEqual(result.inferredTags, [{
      value: 'microphone', confidence: 0.87,
      provenance: 'google-cloud-vision:object-localization@v1:object',
    }])
    assert.equal(result.ocr.state, 'unavailable')
  })
})

test('T-FR-047 Google Cloud Vision adapter reports an executed no-detection result as available and fails closed on malformed evidence', async () => {
  assert.throws(
    () => new GoogleCloudImageVisionProvider({ apiKey: '' }),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
  await sourceFixture(async (sourcePath) => {
    const empty = new GoogleCloudImageVisionProvider({
      apiKey: 'google-cloud-vision-test-key-00001',
      fetchImplementation: async () => new Response(JSON.stringify({ responses: [{}] }), { status: 200 }),
    })
    const result = await empty.analyze({ sourcePath, width: 100, height: 100 })
    assert.deepEqual(result.faces, {
      state: 'available', values: [],
      producer: { provider: 'google-cloud-vision', model: 'face-detection', version: 'v1' },
      reasonCodes: [],
    })
    assert.equal(result.objects.state, 'available')

    const malformed = new GoogleCloudImageVisionProvider({
      apiKey: 'google-cloud-vision-test-key-00001',
      fetchImplementation: async () => new Response(JSON.stringify({ responses: [{
        localizedObjectAnnotations: [{ name: 'Person', score: 2, boundingPoly: {} }],
      }] }), { status: 200 }),
    })
    await assert.rejects(
      malformed.analyze({ sourcePath, width: 100, height: 100 }),
      (error) => error.code === 'RENDER_OUTPUT_INVALID',
    )

    const rejected = new GoogleCloudImageVisionProvider({
      apiKey: 'google-cloud-vision-test-key-00001',
      fetchImplementation: async () => new Response('denied', { status: 403 }),
    })
    await assert.rejects(
      rejected.analyze({ sourcePath, width: 100, height: 100 }),
      (error) => error.code === 'RENDER_EXECUTION_FAILED' && !error.message.includes('denied'),
    )
  })
})

test('T-FR-047 modality composition preserves each producer and rejects ambiguous ownership', async () => {
  const ocr = {
    state: 'available',
    values: [{ text: 'Oferta', language: 'pt-BR', box: [0, 0, 0.2, 0.1], confidence: 0.8, importance: 'medium' }],
    producer: { provider: 'tesseract', model: 'por-eng', version: 'v5' },
    reasonCodes: [],
  }
  const entities = {
    state: 'available',
    values: [{ label: 'Person', box: [0.1, 0.1, 0.2, 0.5], confidence: 0.9 }],
    producer: { provider: 'google-cloud-vision', model: 'object-localization', version: 'v1' },
    reasonCodes: [],
  }
  const ocrProvider = { async analyze() { return {
    ocr, faces: unavailable('FACE_PROVIDER_NOT_CONFIGURED'), objects: unavailable('OBJECT_PROVIDER_NOT_CONFIGURED'),
    inferredTags: [{ value: 'oferta', confidence: 0.8, provenance: 'tesseract:por-eng@v5:ocr:pt-BR' }],
  } } }
  const entityProvider = { async analyze() { return {
    ocr: unavailable('OCR_PROVIDER_NOT_SUPPORTED'), faces: { ...entities, values: [] }, objects: entities,
    inferredTags: [{ value: 'person', confidence: 0.9, provenance: 'google-cloud-vision:object-localization@v1:object' }],
  } } }
  const composite = new CompositeImageVisionProvider([ocrProvider, entityProvider])
  const result = await composite.analyze({ sourcePath: 'unused', width: 100, height: 100 })
  assert.equal(result.ocr.producer.provider, 'tesseract')
  assert.equal(result.objects.producer.provider, 'google-cloud-vision')
  assert.deepEqual(result.inferredTags.map((tag) => tag.value), ['person', 'oferta'].toSorted())

  await assert.rejects(
    new CompositeImageVisionProvider([ocrProvider, ocrProvider]).analyze({ sourcePath: 'unused', width: 100, height: 100 }),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
})

test('T-FR-047 worker configuration is explicit and fails closed without supported entity credentials', () => {
  assert.equal(createConfiguredImageVisionProvider({}), undefined)
  assert.throws(
    () => createConfiguredImageVisionProvider({ APOLLO_IMAGE_ENTITY_PROVIDER: 'unknown' }),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
  assert.throws(
    () => createConfiguredImageVisionProvider({ APOLLO_IMAGE_ENTITY_PROVIDER: 'google-cloud-vision' }),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
  assert.throws(
    () => createConfiguredImageVisionProvider({ APOLLO_TESSERACT_PATH: 'relative/tesseract' }),
    (error) => error.code === 'PERSISTENCE_NOT_CONFIGURED',
  )
})
