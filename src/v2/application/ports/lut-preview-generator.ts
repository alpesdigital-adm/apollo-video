export interface LutPreviewGenerator {
  generate(input: { canonicalCube: string; signal?: AbortSignal }): Promise<Readonly<{
    png: Uint8Array
    width: 512
    height: 288
    sha256: string
  }>>
}
