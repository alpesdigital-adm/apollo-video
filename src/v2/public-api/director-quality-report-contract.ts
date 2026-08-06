import type { DirectorRun } from '../domain/director-run.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'

export function presentDirectorQualityReport(value: Readonly<{
  directorRunId: string
  projectId: string
  objective: StrategicObjectiveId
  objectiveVersion: number
  rubricRef: string
  qualitySnapshot: Readonly<{
    id: string
    contentSchemaVersion: number
    contentHash: string
  }>
  report: Readonly<DirectorRun['qualityReport']>
}>) {
  return {
    directorRunId: value.directorRunId,
    projectId: value.projectId,
    objective: value.objective,
    objectiveVersion: value.objectiveVersion,
    rubricRef: value.rubricRef,
    qualitySnapshot: { ...value.qualitySnapshot },
    report: value.report,
  }
}
