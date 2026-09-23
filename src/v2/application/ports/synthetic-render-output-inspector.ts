export interface SyntheticRenderOutputMeasurement {
  width: number
  height: number
  fps: number
  durationInFrames: number
  codec: string
  audioCodec: string
  container: string
  decodable: boolean
}

export interface SyntheticRenderOutputInspector {
  inspect(input: {
    outputKey: string
    expectedSha256: string
    expectedByteSize: number
    signal?: AbortSignal
  }): Promise<Readonly<SyntheticRenderOutputMeasurement>>
}
