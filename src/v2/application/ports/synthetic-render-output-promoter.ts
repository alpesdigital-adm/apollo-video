export interface SyntheticRenderOutputPromoter {
  promote(input: {
    workspaceId: string
    outputKey: string
    sha256: string
    byteSize: number
  }): Promise<Readonly<{ artifactKey: string; sha256: string; byteSize: number }>>
}
