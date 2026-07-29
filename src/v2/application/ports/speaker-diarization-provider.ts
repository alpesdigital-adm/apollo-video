export interface SpeakerDiarizationProviderResult {
  provider: Readonly<{
    id: string
    model: string
    version: string
  }>
  segments: readonly Readonly<{
    providerSegmentId: string
    providerLabel: string
    startMs: number
    endMs: number
    text: string
  }>[]
  usageSeconds: number
}

export interface SpeakerDiarizationProvider {
  diarize(input: {
    audioPath: string
    language: string
    expectedDurationMs: number
    signal: AbortSignal
  }): Promise<Readonly<SpeakerDiarizationProviderResult>>
}
