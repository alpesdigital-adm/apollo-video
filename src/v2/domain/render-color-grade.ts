import type { ProjectColorPlan } from './project-color-plan.ts'
import type { ProjectLutSelection } from './project-lut-selection.ts'

/**
 * W70 readiness (R2, Opus validation). The colour grade a render of a Version applies: the effective project ColorPlan and the effective LUT
 * selection, both read by ancestry (the nearest Version that set one). The render workers apply them, but neither was part of the pre-render
 * identity: `set-project-color-plan` and `set-project-lut-selection` copy the parent's EditPlan under a new identity, so the content address
 * did not move and a carry could put an ungraded render under a graded Version. The grade is now read with the source, is part of the input
 * hash and of the content address, and the worker refuses to render when the grade it applies is not the one the source was read with.
 */
export const RENDER_COLOR_GRADE_SCHEMA = 'render-color-grade/v1' as const

export type RenderColorGradeV1 = Readonly<{
  schemaVersion: typeof RENDER_COLOR_GRADE_SCHEMA
  colorPlan: Readonly<{ id: string; recordHash: string; planHash: string; compiledManifestHash: string }> | null
  lutSelection: Readonly<{
    id: string
    selectionHash: string
    mode: 'none' | 'lut-version'
    lutVersionId: string | null
    lutRecordHash: string | null
    cubeContentHash: string | null
    intensity: number
  }> | null
}>

export function renderColorGradeOf(input: Readonly<{
  colorPlan: Readonly<ProjectColorPlan> | null
  lutSelection: Readonly<ProjectLutSelection> | null
}>): RenderColorGradeV1 {
  const { colorPlan, lutSelection } = input
  const lut = lutSelection?.resolved.mode === 'lut-version' ? lutSelection.resolved.lut : null
  return Object.freeze({
    schemaVersion: RENDER_COLOR_GRADE_SCHEMA,
    colorPlan: colorPlan
      ? Object.freeze({ id: colorPlan.id, recordHash: colorPlan.recordHash, planHash: colorPlan.plan.planHash, compiledManifestHash: colorPlan.compiled.manifestHash })
      : null,
    lutSelection: lutSelection
      ? Object.freeze({
          id: lutSelection.id, selectionHash: lutSelection.selectionHash, mode: lutSelection.resolved.mode,
          lutVersionId: lut?.versionId ?? null, lutRecordHash: lut?.recordHash ?? null, cubeContentHash: lut?.cubeContentHash ?? null,
          intensity: lutSelection.intensity,
        })
      : null,
  })
}

/** What the grade does to the pixels, without the rows that hold it: two Versions graded alike have the same content (the content address). */
export function renderColorGradeContent(grade: RenderColorGradeV1) {
  return Object.freeze({
    schemaVersion: grade.schemaVersion,
    colorPlan: grade.colorPlan ? { planHash: grade.colorPlan.planHash, compiledManifestHash: grade.colorPlan.compiledManifestHash } : null,
    lut: grade.lutSelection
      ? { mode: grade.lutSelection.mode, lutRecordHash: grade.lutSelection.lutRecordHash, cubeContentHash: grade.lutSelection.cubeContentHash, intensity: grade.lutSelection.intensity }
      : null,
  })
}

/**
 * Whether the grade a worker applies (the effective ColorPlan it compiled the render with, the LUT selection it materialized) is the one the
 * source was read with. Rows are compared by id and seal, so a grade re-set to the same values under another Version is another grade here.
 */
export function appliedColorGradeMatches(grade: RenderColorGradeV1, applied: Readonly<{
  colorPlan: Readonly<Pick<ProjectColorPlan, 'id' | 'recordHash'>> | null
  lut: Readonly<{ selectionId: string; selectionHash: string }>
}>): boolean {
  const planMatches = grade.colorPlan === null
    ? applied.colorPlan === null
    : applied.colorPlan !== null && applied.colorPlan.id === grade.colorPlan.id && applied.colorPlan.recordHash === grade.colorPlan.recordHash
  const lutMatches = grade.lutSelection !== null &&
    applied.lut.selectionId === grade.lutSelection.id && applied.lut.selectionHash === grade.lutSelection.selectionHash
  return planMatches && lutMatches
}
