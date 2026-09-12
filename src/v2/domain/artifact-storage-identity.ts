import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

const OUTPUT_ARTIFACT_KINDS = new Set(['editorial-proxy', 'final-export'])

/**
 * Content hashes verify bytes; they do not own product identity. Derived output
 * keys include the already-reserved artifact id so byte-identical outputs from
 * different projects keep independent manifests, lineage and replay identity.
 */
export function artifactOutputStoragePrefix(
  kind: 'editorial-proxy' | 'final-export',
  outputArtifactId: string,
): string {
  if (!OUTPUT_ARTIFACT_KINDS.has(kind)) {
    throw new DomainError('INVALID_ARGUMENT', 'Output artifact kind is invalid')
  }
  if (!outputArtifactId || outputArtifactId.length > 256 || /\s/.test(outputArtifactId)) {
    throw new DomainError('INVALID_ARGUMENT', 'Output artifact identity is invalid')
  }
  return calculateCanonicalHash([kind, outputArtifactId]).slice(0, 32)
}
