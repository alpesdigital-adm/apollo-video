import { DomainError } from '../domain/errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export function parsePerceptionProducerRunRequest(raw: unknown): Readonly<{
  projectVersionId: string
  sourceArtifactId: string
  sampleIntervalFrames?: number
}> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('INVALID_ARGUMENT', 'Perception producer request must be an object')
  }
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => !['projectVersionId', 'sourceArtifactId', 'sampleIntervalFrames'].includes(key)) ||
      typeof value.projectVersionId !== 'string' || !ID.test(value.projectVersionId) ||
      typeof value.sourceArtifactId !== 'string' || !ID.test(value.sourceArtifactId) ||
      (value.sampleIntervalFrames !== undefined &&
        (!Number.isSafeInteger(value.sampleIntervalFrames) || Number(value.sampleIntervalFrames) < 1 || Number(value.sampleIntervalFrames) > 300))) {
    throw new DomainError('INVALID_ARGUMENT', 'Perception producer request fields are invalid')
  }
  return Object.freeze({
    projectVersionId: value.projectVersionId,
    sourceArtifactId: value.sourceArtifactId,
    ...(value.sampleIntervalFrames !== undefined ? { sampleIntervalFrames: value.sampleIntervalFrames as number } : {}),
  })
}

export function parseTemporalProducerRunRequest(raw: unknown): Readonly<{
  projectVersionId: string; sourceArtifactId: string
}> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('INVALID_ARGUMENT', 'Temporal producer request must be an object')
  }
  const value = raw as Record<string, unknown>
  if (Object.keys(value).sort().join('|') !== 'projectVersionId|sourceArtifactId' ||
      typeof value.projectVersionId !== 'string' || !ID.test(value.projectVersionId) ||
      typeof value.sourceArtifactId !== 'string' || !ID.test(value.sourceArtifactId)) {
    throw new DomainError('INVALID_ARGUMENT', 'Temporal producer request fields are invalid')
  }
  return Object.freeze({ projectVersionId: value.projectVersionId,
    sourceArtifactId: value.sourceArtifactId })
}

/** Face requests accept source identity and cadence only; scores and approvals are server-owned. */
export function parseFaceProducerRunRequest(raw: unknown): ReturnType<typeof parsePerceptionProducerRunRequest> {
  return parsePerceptionProducerRunRequest(raw)
}

/** A V9 face window: identity of the source and the timeline frames to observe; cadence and scores are server-owned. */
export function parseFaceWindowRunRequest(raw: unknown): Readonly<{
  projectVersionId: string; sourceArtifactId: string
  window: Readonly<{ startTimelineFrame: number; endTimelineFrame: number }>
}> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('INVALID_ARGUMENT', 'Face window request must be an object')
  }
  const value = raw as Record<string, unknown>
  const window = value.window as Record<string, unknown> | undefined
  if (Object.keys(value).sort().join('|') !== 'projectVersionId|sourceArtifactId|window' ||
      typeof value.projectVersionId !== 'string' || !ID.test(value.projectVersionId) ||
      typeof value.sourceArtifactId !== 'string' || !ID.test(value.sourceArtifactId) ||
      !window || typeof window !== 'object' || Array.isArray(window) ||
      Object.keys(window).sort().join('|') !== 'endTimelineFrame|startTimelineFrame' ||
      !Number.isSafeInteger(window.startTimelineFrame) || Number(window.startTimelineFrame) < 0 ||
      !Number.isSafeInteger(window.endTimelineFrame) || Number(window.endTimelineFrame) <= Number(window.startTimelineFrame) ||
      Number(window.endTimelineFrame) - Number(window.startTimelineFrame) > 300) {
    throw new DomainError('INVALID_ARGUMENT', 'Face window request fields are invalid')
  }
  return Object.freeze({
    projectVersionId: value.projectVersionId, sourceArtifactId: value.sourceArtifactId,
    window: Object.freeze({ startTimelineFrame: window.startTimelineFrame as number, endTimelineFrame: window.endTimelineFrame as number }),
  })
}
