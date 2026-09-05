/**
 * The files a compiled plan is allowed to cut from, as the server measured them
 * (F4.015, F4.016 condition 6).
 *
 * Both Wave 20 compilers need the same three facts about every source they
 * declare — its media-artifact id, the bytes behind it, and how long the file
 * actually runs — and neither may take them from the caller. CONTRACT.md §2 is
 * explicit: the caller supplies ids, the server supplies measurements. A
 * compiler that accepted a declared `sha256` would let a caller who knows the
 * lineage digest walk past the identity check by naming it, and a compiler that
 * accepted a declared `durationSeconds` would stamp an unmeasured number into
 * the provenance of a stored plan.
 *
 * The lookup deliberately goes through the *project's* media-asset links rather
 * than straight at `media_artifacts`, because that is the lookup the render path
 * itself performs: `PrismaProjectProxyRenderRepository` resolves every
 * `clip.sourceArtifactId` through `project.mediaAssets` and refuses with
 * `PERSISTENCE_CONFLICT` when it misses. A plan whose sources resolve here is a
 * plan whose sources the renderer can find; one that does not is refused at
 * compile time, where the refusal still names the derivation.
 */
export interface ResolvedRenderSource {
  readonly artifactId: string
  /** The bytes the artifact registry holds right now. */
  readonly sha256: string
  readonly byteSize: number
  readonly mediaType: 'video' | 'audio'
  /**
   * Measured on the file at ingest and read back from the artifact's manifest
   * probe. Null when the manifest carries no probe: absent is not zero, and the
   * compiler that needs a duration refuses by name rather than defaulting.
   */
  readonly durationSeconds: number | null
}

export interface RenderSourceRepository {
  /**
   * The subset of `artifactIds` this project may render from, measured.
   *
   * An id with no link to the project is simply absent from the result — the
   * caller knows which derivation asked for it and refuses by name. An id that
   * *is* linked but cannot be rendered from (quarantined, deleted, an image, no
   * manifest) is a broken link rather than a missing one, and the adapter
   * refuses with `PERSISTENCE_CONFLICT` in the same words the render path uses.
   */
  resolveForProject(input: {
    workspaceId: string
    projectId: string
    artifactIds: readonly string[]
  }): Promise<readonly Readonly<ResolvedRenderSource>[]>
}
