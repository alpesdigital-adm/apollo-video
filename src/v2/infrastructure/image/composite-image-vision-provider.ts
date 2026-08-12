import type { ImageVisionProvider } from '../../application/ports/image-analysis.ts'
import type {
  ImageObservation,
  ImageObservationProducer,
} from '../../domain/image-analysis.ts'
import { DomainError } from '../../domain/errors.ts'
import { GoogleCloudImageVisionProvider } from './google-cloud-image-vision-provider.ts'
import { TesseractImageVisionProvider } from './tesseract-image-vision-provider.ts'

type VisionResult = Awaited<ReturnType<ImageVisionProvider['analyze']>>

function unavailable<T>(
  observations: readonly ImageObservation<T>[],
): Readonly<ImageObservation<T>> {
  const reasonCodes = observations
    .flatMap((observation) => observation.reasonCodes)
    .filter((reason, index, all) => all.indexOf(reason) === index)
    .toSorted()
  return Object.freeze({
    state: 'unavailable',
    values: Object.freeze([]),
    producer: Object.freeze({
      provider: 'composite',
      model: 'unavailable',
      version: 'v1',
    }),
    reasonCodes: Object.freeze(
      reasonCodes.length > 0 ? reasonCodes : ['VISION_PROVIDER_UNAVAILABLE'],
    ),
  })
}

function selectObservation<T>(
  observations: readonly ImageObservation<T>[],
  field: 'ocr' | 'faces' | 'objects',
): Readonly<ImageObservation<T>> {
  const available = observations.filter((observation) => observation.state === 'available')
  if (available.length > 1) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      `Multiple image vision providers own ${field}`,
    )
  }
  return available[0] ?? unavailable(observations)
}

function producerKey(producer: ImageObservationProducer) {
  return `${producer.provider}:${producer.model}@${producer.version}`
}

/**
 * Composes providers by modality. Exactly one provider may own OCR, faces or
 * objects, preventing confidence values from different models from being
 * silently mixed under one producer identity.
 */
export class CompositeImageVisionProvider implements ImageVisionProvider {
  private readonly providers: readonly ImageVisionProvider[]

  constructor(providers: readonly ImageVisionProvider[]) {
    if (providers.length < 1) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'At least one image vision provider is required',
      )
    }
    this.providers = Object.freeze([...providers])
  }

  async analyze(input: Parameters<ImageVisionProvider['analyze']>[0]) {
    const results = await Promise.all(
      this.providers.map((provider) => provider.analyze(input)),
    )
    const ocr = selectObservation(results.map((result) => result.ocr), 'ocr')
    const faces = selectObservation(results.map((result) => result.faces), 'faces')
    const objects = selectObservation(results.map((result) => result.objects), 'objects')
    const owners = new Set([
      producerKey(ocr.producer),
      producerKey(faces.producer),
      producerKey(objects.producer),
    ])
    const inferredTags = results
      .flatMap((result) => result.inferredTags)
      .filter((tag, index, all) =>
        all.findIndex((candidate) =>
          candidate.value === tag.value &&
          candidate.provenance === tag.provenance) === index)
      .filter((tag) =>
        [...owners].some((owner) => tag.provenance.startsWith(`${owner}:`)))
      .toSorted((left, right) =>
        left.value.localeCompare(right.value) ||
        left.provenance.localeCompare(right.provenance))
      .map((tag) => Object.freeze({ ...tag }))
    return Object.freeze({
      ocr,
      faces,
      objects,
      inferredTags: Object.freeze(inferredTags),
    })
  }
}

export function createConfiguredImageVisionProvider(
  environment: NodeJS.ProcessEnv,
): ImageVisionProvider | undefined {
  const providers: ImageVisionProvider[] = []
  if (environment.APOLLO_TESSERACT_PATH?.trim()) {
    providers.push(new TesseractImageVisionProvider({
      binary: environment.APOLLO_TESSERACT_PATH.trim(),
    }))
  }
  const entityProvider = environment.APOLLO_IMAGE_ENTITY_PROVIDER?.trim().toLowerCase()
  if (entityProvider && entityProvider !== 'google-cloud-vision') {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Configured image entity provider is not supported',
    )
  }
  if (entityProvider === 'google-cloud-vision') {
    providers.push(new GoogleCloudImageVisionProvider({
      apiKey: environment.GOOGLE_CLOUD_VISION_API_KEY ?? '',
    }))
  }
  return providers.length > 0
    ? new CompositeImageVisionProvider(providers)
    : undefined
}
