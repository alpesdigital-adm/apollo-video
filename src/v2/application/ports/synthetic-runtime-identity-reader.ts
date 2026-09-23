import type { SyntheticBuildIdentity } from '../../domain/synthetic-build-attestation.ts'

export interface SyntheticRuntimeIdentityReader {
  read(input?: { signal?: AbortSignal }): Promise<Readonly<SyntheticBuildIdentity>>
}
