export interface MediaSegmentExtractor {
  extract(input: { operationId: string; sourcePath: string; startMs: number; endMs: number; signal?: AbortSignal }): Promise<Readonly<{
    outputPath: string; sha256: string; byteSize: number; probe: { width: number; height: number; duration: number; fps: number }
  }>>
  cleanup(operationId: string): Promise<void>
}
