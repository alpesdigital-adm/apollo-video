export interface ArtifactByteRange {
  start: number
  end: number
}

export interface ArtifactContentStorage {
  open(input: {
    artifactKey: string
    expectedByteSize: bigint
    range?: Readonly<ArtifactByteRange>
  }): Promise<Readonly<{
    body: ReadableStream<Uint8Array>
    byteSize: number
    start: number
    end: number
  }>>
}
