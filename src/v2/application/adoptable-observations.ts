import type { AdoptableObservationV3 } from '../domain/output-child-command.ts'
import type { OperationalOutputParentV3 } from '../domain/output-version-bundle.ts'
import { unobservedSourceArtifactIds } from '../domain/project-output-state-transition.ts'
import type { AdoptableObservationReader } from './ports/adoptable-observation-reader.ts'

/**
 * The receipts to offer a child Command whose new plan consumes recordings its parent State does not observe: read
 * only for those recordings, and not at all when the plan consumes nothing new. The transition adopts what it needs
 * from them and refuses, naming the artifact, a recording nobody persisted an observation for.
 */
export async function offeredObservationsFor(reader: Partial<AdoptableObservationReader>, parent: OperationalOutputParentV3,
  plan: Readonly<Record<string, unknown>>): Promise<readonly Readonly<AdoptableObservationV3>[]> {
  const missing = unobservedSourceArtifactIds(parent, plan)
  if (missing.length === 0 || reader.readAdoptableObservations === undefined) return []
  return reader.readAdoptableObservations({ workspaceId: parent.version.workspaceId, projectId: parent.version.projectId, sourceArtifactIds: missing })
}
