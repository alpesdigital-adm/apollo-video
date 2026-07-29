export interface PreparedSpeakerDiarizationAudio {
  audioPath: string
  sha256: string
  byteSize: number
  durationMs: number
  preparation: Readonly<{
    toolId: string
    toolVersion: string
    configurationHash: string
  }>
}

export interface SpeakerDiarizationAudioPreparer {
  prepare(input: {
    operationId: string
    sourceArtifactKey: string
    sourceArtifactSha256: string
    sourceArtifactByteSize: bigint
    expectedDurationMs: number
    signal: AbortSignal
  }): Promise<Readonly<PreparedSpeakerDiarizationAudio>>
  cleanup(operationId: string): Promise<void>
}
