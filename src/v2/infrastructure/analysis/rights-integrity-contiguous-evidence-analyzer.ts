import type {
  ContiguousEvidenceAnalyzer,
} from '../../application/ports/contiguous-evidence-repository.ts'
import { DomainError } from '../../domain/errors.ts'

export const RIGHTS_INTEGRITY_ANALYZER_IDENTITY = Object.freeze({
  provider: 'apollo',
  model: 'rights-integrity-policy',
  version: '1.0.0',
  kind: 'rights-integrity' as const,
})

export class RightsIntegrityContiguousEvidenceAnalyzer
implements ContiguousEvidenceAnalyzer {
  readonly identity = RIGHTS_INTEGRITY_ANALYZER_IDENTITY

  async analyze(
    source: Parameters<ContiguousEvidenceAnalyzer['analyze']>[0],
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Rights integrity analysis was aborted',
      )
    }
    if (
      source.rightsStatus !== 'approved' ||
      !['approved', 'not-required'].includes(source.consentStatus)
    ) {
      throw new DomainError(
        'ASSET_RIGHTS_BLOCKED',
        'Rights integrity analysis requires current approved rights',
      )
    }
    return Object.freeze(source.moments.map((moment) =>
      Object.freeze({
        momentId: moment.id,
        rangeMs: moment.recommendedRangeMs,
        dimensions: Object.freeze(['integrity'] as const),
        facts: Object.freeze({
          rightsApproved: true,
          consentApproved:
            source.consentStatus === 'approved',
          consentNotRequired:
            source.consentStatus === 'not-required',
          rightsSnapshotId: source.rightsSnapshotId,
        }),
      })))
  }
}
