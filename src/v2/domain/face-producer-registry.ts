import type { FaceProducerEnvelopeV2, FaceProducerV2 } from './face-producer-envelope-v2.ts'
import { FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256 } from './face-detector-output.ts'
import { FACE_V9_OWNER_ACCEPTANCE_SHA256 } from './face-evidence-policy.ts'

/**
 * Producers whose face evidence the product trusts. A sealed envelope proves what ran; this registry says
 * whether that is the thing the owner accepted. Evidence from any other producer, platform or runtime still reads
 * (it is data) but is unauthenticated: clearance over it is `unknown`, never `free-certified`.
 *
 * The Linux production runtime is deliberately absent. It enters this list only with the SHA-256 of a passed,
 * supervised parity run of the 60 development images against the V9 tensors (no tuning); until then the worker
 * refuses to start there and any envelope claiming it stays unauthenticated.
 */
export const FACE_V9_RECEIPT_SHA256 = '390d3b28d172015f8ed2cb3d416e38625ce4d4efaca8e1eea52d7a8e58aaa817'
export const FACE_V9_PREREGISTRATION_SHA256 = '86201715d31731757f0756fd54f1e73e158d08cdc1ec9fcba5fad36e6efd720c'

type AcceptedPlatform = Readonly<{
  platform: 'win32' | 'linux'
  pythonVersion: string; openvinoVersion: string; openvinoPackageVersion: string
  opencvVersion: string; numpyVersion: string
  /** SHA-256 of the receipt that proves this platform reproduces the accepted V9 behavior. */
  parityReceiptSha256: string
}>
type AcceptedProducer = Readonly<{
  id: string
  name: FaceProducerV2['name']
  model: Readonly<{ xmlSha256: string; binSha256: string; xmlBytes: number; binBytes: number; licenseSha256: string; sourceCommit: string }>
  outputPolicy: Readonly<{ id: string; sha256: string }>
  v9ReceiptSha256: string; v9PreregistrationSha256: string; ownerAcceptanceSha256: string
  platforms: readonly AcceptedPlatform[]
}>

export const ACCEPTED_FACE_PRODUCERS: readonly AcceptedProducer[] = Object.freeze([Object.freeze({
  id: 'omz-face-detection-0204-v9',
  name: 'openvino-face-detection-0204' as const,
  model: Object.freeze({
    xmlSha256: '33394c03a4c88cbcd2537c5d232c149b69f2a7ad406d85d2323d7303f17d7ee3',
    binSha256: '0bbc0e08b297ce385b67ad742fd7612947e855c8f50c625b94835f883a6e4102',
    xmlBytes: 185457, binBytes: 7269196,
    licenseSha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    sourceCommit: 'eda1863a6d60b09551df9d039cff2377d6ddd4d6',
  }),
  outputPolicy: Object.freeze({ id: FACE0204_OUTPUT_POLICY_ID, sha256: FACE0204_OUTPUT_POLICY_SHA256 }),
  v9ReceiptSha256: FACE_V9_RECEIPT_SHA256,
  v9PreregistrationSha256: FACE_V9_PREREGISTRATION_SHA256,
  ownerAcceptanceSha256: FACE_V9_OWNER_ACCEPTANCE_SHA256,
  platforms: Object.freeze([Object.freeze({
    platform: 'win32' as const,
    pythonVersion: '3.14', openvinoVersion: '2026.4.0-22959-99c81491cc3-releases/2026/4',
    openvinoPackageVersion: '2026.4.0', opencvVersion: '4.13.0', numpyVersion: '2.5.1',
    // The V9 development receipt was produced on this platform and runtime; it is its own parity evidence.
    parityReceiptSha256: FACE_V9_RECEIPT_SHA256,
  })]),
})])

export type FaceProducerAuthentication = Readonly<{ authenticated: boolean; reasons: readonly string[] }>

/** Reasons the observed runtime is not the platform and versions the owner accepted (none when it is). */
export function acceptedFaceRuntimeReasons(runtime: Pick<FaceProducerV2['runtime'], 'platform' | 'pythonVersion' |
  'openvinoVersion' | 'openvinoPackageVersion' | 'opencvVersion' | 'numpyVersion'>): readonly string[] {
  const platform = ACCEPTED_FACE_PRODUCERS[0]!.platforms.find((entry) => entry.platform === runtime.platform)
  if (!platform) return Object.freeze(['RUNTIME_PLATFORM_NOT_PARITIED'])
  return Object.freeze(runtime.pythonVersion === platform.pythonVersion && runtime.openvinoVersion === platform.openvinoVersion &&
    runtime.openvinoPackageVersion === platform.openvinoPackageVersion && runtime.opencvVersion === platform.opencvVersion &&
    runtime.numpyVersion === platform.numpyVersion ? [] : ['RUNTIME_VERSION_MISMATCH'])
}

export function authenticateFaceProducer(producer: FaceProducerV2): FaceProducerAuthentication {
  const reasons: string[] = []
  const accepted = ACCEPTED_FACE_PRODUCERS.find((candidate) => candidate.name === producer.name &&
    candidate.model.xmlSha256 === producer.model.xmlSha256)
  if (!accepted) return Object.freeze({ authenticated: false, reasons: Object.freeze(['PRODUCER_NOT_ACCEPTED']) })
  for (const [key, expected] of Object.entries(accepted.model) as Array<[keyof typeof accepted.model, string | number]>) {
    if (producer.model[key] !== expected) reasons.push(`MODEL_${key.toUpperCase()}_MISMATCH`)
  }
  if (producer.outputPolicy.id !== accepted.outputPolicy.id || producer.outputPolicy.sha256 !== accepted.outputPolicy.sha256) {
    reasons.push('OUTPUT_POLICY_MISMATCH')
  }
  const assessment = producer.assessment
  if (assessment.ownerAcceptanceSha256 !== accepted.ownerAcceptanceSha256 ||
      assessment.v9ReceiptSha256 !== accepted.v9ReceiptSha256 ||
      assessment.v9PreregistrationSha256 !== accepted.v9PreregistrationSha256) reasons.push('ASSESSMENT_MISMATCH')
  reasons.push(...acceptedFaceRuntimeReasons(producer.runtime))
  const platform = accepted.platforms.find((entry) => entry.platform === producer.runtime.platform)
  if (platform) {
    const parity = assessment.runtimeParity
    if (parity.status !== 'passed' || parity.receiptSha256 !== platform.parityReceiptSha256) reasons.push('RUNTIME_PARITY_MISMATCH')
  }
  return Object.freeze({ authenticated: reasons.length === 0, reasons: Object.freeze(reasons) })
}

export function authenticateFaceEnvelope(envelope: Pick<FaceProducerEnvelopeV2, 'producer'>): FaceProducerAuthentication {
  return authenticateFaceProducer(envelope.producer)
}

/** Platforms on which the worker may run at all; anything else fails closed at startup. */
export function faceWorkerPlatformAccepted(platform: string): boolean {
  return ACCEPTED_FACE_PRODUCERS.some((producer) => producer.platforms.some((entry) => entry.platform === platform))
}
