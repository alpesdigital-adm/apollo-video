import type { CreationOutputBundleRepositoryV2 } from './output-version-bundle-repository.ts'

/** Creation commits the complete Command2/State2/Version2 root. A bare
 * Version or project.format is not accepted by this port. */
export interface ProjectCreationRepository extends CreationOutputBundleRepositoryV2 {}
