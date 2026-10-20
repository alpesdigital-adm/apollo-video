/**
 * W68. The pure half of the issue -> override -> recompile -> re-critic surface of the editor.
 *
 * Nothing here touches the network, the DOM or the clock. It turns the proxy review the server persisted into chips (severity `review` /
 * `block`, never hidden evidence), builds the exact Command bodies the panel sends (the full desired dimension set, never a partial
 * merge the server would read as a replacement), names a failed request in the operator's language, and compares the issues of two
 * reviews. It has no "resolve": an issue leaves the list only when a NEW review no longer reports it.
 */

export type IssueSeverityChip = 'review' | 'block'
export type IssueDomain = 'caption' | 'reframe' | 'other'

export interface ReviewIssueInput {
  code: string
  severity: 'hard' | 'warning'
  category?: string
  message: string
  rangeMs?: readonly [number, number]
  targetId?: string
  outputSpecId?: string
  evidenceRange?: { startFrame: number; endFrame: number }
  elementIds?: readonly string[]
  evidenceIds?: readonly string[]
  correctable?: boolean
  outputPresetHash?: string
  placementPlanHash?: string | null
  reframePlanHash?: string | null
}

export interface ReviewInput {
  id: string
  projectVersionId: string
  proxyArtifactId: string
  proxyManifestId: string
  inputHash: string
  outputSpecId: string
  reviewHash: string
  revision: number
  status: 'blocked' | 'warning-ack-required' | 'ready-for-final'
  warningsAcknowledged: boolean
  technicalIssues: readonly ReviewIssueInput[]
  criticIssues: readonly ReviewIssueInput[]
  formatQuality?: { outputPresetHash: string; status: string; exportAllowed: boolean; explanation: string; reportHash: string }
  acknowledgedBy?: { type: string; id: string; at: string }
}

export interface IssueChip {
  key: string
  severity: IssueSeverityChip
  domain: IssueDomain
  code: string
  message: string
  range: { startFrame: number; endFrame: number } | null
  /** `cue-id` for a caption issue; null otherwise. */
  cueId: string | null
  elementIds: readonly string[]
  evidenceIds: readonly string[]
  /** A warning can be acknowledged in the review (with actor and time); a block never can. */
  acknowledgeable: boolean
  variantId: string
  source: ReviewIssueInput
}

export const CHIP_LABELS: Readonly<Record<IssueSeverityChip, string>> = Object.freeze({ review: 'Revisar', block: 'Bloqueado' })

export const CAPTION_ISSUE_CODES = Object.freeze([
  'FACE_PERCEPTION_UNAVAILABLE', 'NO_SAFE_SUBTITLE_REGION', 'SUBTITLE_ANCHOR_FALLBACK', 'SUBTITLE_ANCHOR_UNSTABLE',
  'CAPTION_PLACEMENT_MISMATCH', 'SUBTITLE_FACE_OVERLAP_IN_PIXELS', 'FACE_PIXEL_CHECK_UNAVAILABLE',
] as const)

const SUBTITLE_ELEMENT = /^subtitle:(.+)$/

export function severityChip(severity: 'hard' | 'warning'): IssueSeverityChip {
  return severity === 'hard' ? 'block' : 'review'
}

export function cueIdOf(issue: Pick<ReviewIssueInput, 'elementIds' | 'targetId'>): string | null {
  for (const id of [...(issue.elementIds ?? []), ...(issue.targetId ? [issue.targetId] : [])]) {
    const match = SUBTITLE_ELEMENT.exec(id)
    if (match) return match[1]!
  }
  return null
}

export function issueDomain(issue: Pick<ReviewIssueInput, 'code' | 'elementIds' | 'targetId'>): IssueDomain {
  if (issue.code.startsWith('REFRAME_')) return 'reframe'
  if ((CAPTION_ISSUE_CODES as readonly string[]).includes(issue.code) || cueIdOf(issue) !== null) return 'caption'
  return 'other'
}

/** Identity of an issue across two reviews of the same output: what, where and which element. The Version is not part of it. */
export function issueKey(issue: Pick<ReviewIssueInput, 'code' | 'elementIds' | 'targetId' | 'evidenceRange' | 'outputSpecId'>): string {
  const range = issue.evidenceRange ? `${issue.evidenceRange.startFrame}-${issue.evidenceRange.endFrame}` : 'all'
  return [issue.outputSpecId ?? '', issue.code, [...(issue.elementIds ?? [])].toSorted().join(','), issue.targetId ?? '', range].join('|')
}

/** Every issue of one review as a chip. Nothing is dropped, truncated or reordered away: hard first, then by position. */
export function issueChips(review: ReviewInput, variantId: string): readonly IssueChip[] {
  const issues = [...review.technicalIssues, ...review.criticIssues]
  const chips = issues.map((issue): IssueChip => ({
    key: issueKey({ ...issue, outputSpecId: issue.outputSpecId ?? review.outputSpecId }),
    severity: severityChip(issue.severity),
    domain: issueDomain(issue),
    code: issue.code,
    message: issue.message,
    range: issue.evidenceRange ? { startFrame: issue.evidenceRange.startFrame, endFrame: issue.evidenceRange.endFrame } : null,
    cueId: cueIdOf(issue),
    elementIds: issue.elementIds ?? [],
    evidenceIds: issue.evidenceIds ?? [],
    acknowledgeable: issue.severity === 'warning',
    variantId,
    source: issue,
  }))
  return chips.toSorted((left, right) =>
    (left.severity === right.severity ? 0 : left.severity === 'block' ? -1 : 1) ||
    (left.range?.startFrame ?? -1) - (right.range?.startFrame ?? -1) || left.code.localeCompare(right.code) || left.key.localeCompare(right.key))
}

export function timecode(frame: number, fps: number): string {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) return '00:00:00:00'
  const whole = Math.max(0, Math.round(frame))
  const rate = Math.max(1, Math.round(fps))
  const seconds = Math.floor(whole / rate)
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60, whole % rate].map((part) => String(part).padStart(2, '0')).join(':')
}

export interface ProvenanceRow { label: string; value: string; kind: 'hash' | 'id' | 'text' }

/**
 * The evidence and provenance of one chip, in the order a reviewer reads them. It is built from what the review carries and is never
 * collapsed away: an empty list says so, it does not hide.
 */
export function issueProvenance(chip: IssueChip, review: ReviewInput, proxy: { artifactId: string; sha256: string | null }): readonly ProvenanceRow[] {
  const rows: ProvenanceRow[] = [
    { label: 'Saída', value: chip.variantId, kind: 'id' },
    { label: 'Laudo', value: review.reviewHash, kind: 'hash' },
    { label: 'Entrada do render', value: review.inputHash, kind: 'hash' },
    { label: 'Proxy', value: proxy.artifactId, kind: 'id' },
  ]
  if (proxy.sha256) rows.push({ label: 'Proxy sha256', value: proxy.sha256, kind: 'hash' })
  if (review.formatQuality) {
    rows.push({ label: 'Laudo de formato', value: review.formatQuality.reportHash, kind: 'hash' })
    rows.push({ label: 'Preset da saída', value: review.formatQuality.outputPresetHash, kind: 'hash' })
  }
  if (chip.source.placementPlanHash) rows.push({ label: 'Plano de posicionamento', value: chip.source.placementPlanHash, kind: 'hash' })
  if (chip.source.reframePlanHash) rows.push({ label: 'Plano de reenquadramento', value: chip.source.reframePlanHash, kind: 'hash' })
  for (const id of chip.elementIds) rows.push({ label: 'Elemento', value: id, kind: 'id' })
  for (const id of chip.evidenceIds) rows.push({ label: 'Evidência', value: id, kind: 'id' })
  return rows
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export const SUBTITLE_ANCHOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  top: 'Topo', 'upper-third': 'Terço superior', center: 'Centro', 'lower-third': 'Terço inferior', bottom: 'Base',
})
export const SUBTITLE_PRESET_LABELS: Readonly<Record<string, string>> = Object.freeze({
  kinetic: 'Cinético', 'karaoke-box': 'Karaokê com caixa', 'karaoke-pill': 'Karaokê em pílula', 'caps-stroke': 'Maiúsculas com contorno', 'clean-color': 'Limpo com cor',
})
export const SUBTITLE_TEXT_MAX = 200

export type SubtitleDimension =
  | { kind: 'position'; anchor: string }
  | { kind: 'style'; presetId: string; presetVersion: 1; presetHash: string }
  | { kind: 'text'; text: string }
  | { kind: 'visibility'; visible: boolean }

/** What the operator changed. `undefined` leaves the dimension as it is; `null` returns it to the inherited level. */
export interface SubtitleDraft {
  anchor?: string | null
  text?: string | null
  visible?: boolean | null
  presetId?: string | null
}

const KIND_ORDER = ['position', 'style', 'text', 'visibility'] as const

/**
 * The COMPLETE dimension list the segment must carry after the Command. A `set` replaces the head, it does not merge into it, so a
 * dimension the operator did not touch is carried over from the current head or the earlier exception would be silently dropped.
 */
export function mergeSubtitleDimensions(
  current: readonly SubtitleDimension[],
  draft: SubtitleDraft,
  presetHashes: Readonly<Record<string, string>>,
): readonly SubtitleDimension[] {
  const next = new Map<string, SubtitleDimension>(current.map((dimension) => [dimension.kind, dimension]))
  if (draft.anchor !== undefined) {
    if (draft.anchor === null) next.delete('position'); else next.set('position', { kind: 'position', anchor: draft.anchor })
  }
  if (draft.presetId !== undefined) {
    if (draft.presetId === null) next.delete('style')
    else {
      const presetHash = presetHashes[draft.presetId]
      if (!presetHash) throw new Error(`Predefinição desconhecida: ${draft.presetId}`)
      next.set('style', { kind: 'style', presetId: draft.presetId, presetVersion: 1, presetHash })
    }
  }
  if (draft.text !== undefined) {
    const text = draft.text === null ? '' : draft.text.normalize('NFC').replace(/\r?\n/g, '\n').trim()
    if (text.length === 0) next.delete('text'); else next.set('text', { kind: 'text', text })
  }
  if (draft.visible !== undefined) {
    // Visible is the inherited level: only hiding is an exception.
    if (draft.visible === null || draft.visible === true) next.delete('visibility'); else next.set('visibility', { kind: 'visibility', visible: false })
  }
  return KIND_ORDER.flatMap((kind) => next.has(kind) ? [next.get(kind)!] : [])
}

export function validateSubtitleDimensions(dimensions: readonly SubtitleDimension[]): string | null {
  if (dimensions.length === 0) return 'Altere ao menos uma propriedade da legenda, ou use "Reverter exceção".'
  for (const dimension of dimensions) {
    if (dimension.kind === 'text' && (dimension.text.length < 1 || dimension.text.length > SUBTITLE_TEXT_MAX)) return `O texto deve ter entre 1 e ${SUBTITLE_TEXT_MAX} caracteres.`
  }
  return null
}

export interface CommandBase { baseVersionId: string; baseHash: string; variantId: string }

export function subtitleSetBody(base: CommandBase, input: { segmentId: string; dimensions: readonly SubtitleDimension[]; protectedException: boolean; reason?: string }) {
  return {
    baseVersionId: base.baseVersionId, baseHash: base.baseHash, variantId: base.variantId, segmentId: input.segmentId, action: 'set' as const,
    dimensions: input.dimensions, protected: input.protectedException,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  }
}

export function subtitleResetBody(base: CommandBase, input: { segmentId: string; reason?: string }) {
  return {
    baseVersionId: base.baseVersionId, baseHash: base.baseHash, variantId: base.variantId, segmentId: input.segmentId, action: 'reset' as const,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  }
}

export interface CropBounds { x: number; y: number; width: number; height: number }

/** A manual crop only pans: it keeps the size of the crop the plan uses on the range and moves it, inside the frame. */
export function panCrop(reference: CropBounds, x: number, y = reference.y): CropBounds {
  const clamp = (value: number, max: number) => Math.min(Math.max(0, value), Math.max(0, max))
  return { x: Number(clamp(x, 1 - reference.width).toFixed(6)), y: Number(clamp(y, 1 - reference.height).toFixed(6)), width: reference.width, height: reference.height }
}

export function reframeSetBody(base: CommandBase, input: { clipId: string; startFrame: number; endFrame: number; crop: CropBounds; reason?: string }) {
  return {
    baseVersionId: base.baseVersionId, baseHash: base.baseHash, variantId: base.variantId, clipId: input.clipId,
    startFrame: input.startFrame, endFrame: input.endFrame, action: 'set' as const, crop: input.crop,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  }
}

export function reframeResetBody(base: CommandBase, input: { clipId: string; startFrame: number; endFrame: number; reason?: string }) {
  return {
    baseVersionId: base.baseVersionId, baseHash: base.baseHash, variantId: base.variantId, clipId: input.clipId,
    startFrame: input.startFrame, endFrame: input.endFrame, action: 'reset' as const,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  }
}

export function validateFrameRange(range: { startFrame: number; endFrame: number }, bounds: { startFrame: number; endFrame: number }): string | null {
  if (!Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrame)) return 'Informe quadros inteiros.'
  if (range.endFrame <= range.startFrame) return 'O quadro final deve ser maior que o inicial.'
  if (range.startFrame < bounds.startFrame || range.endFrame > bounds.endFrame) return `A faixa deve ficar dentro do clipe (${bounds.startFrame}–${bounds.endFrame}).`
  return null
}

/**
 * One request, one key: retrying the SAME payload reuses the key (the server replays it), a different payload gets another one. The
 * fingerprint is the body without anything the operator did not decide.
 */
export function createIdempotencyKeys(random: () => string) {
  const keys = new Map<string, string>()
  return (scope: string, body: unknown): string => {
    const fingerprint = `${scope}:${JSON.stringify(body)}`
    let key = keys.get(fingerprint)
    if (!key) { key = `w68-${scope}-${random()}`.slice(0, 128); keys.set(fingerprint, key) }
    return key
  }
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

export type CommandFailureKind = 'session-expired' | 'not-found' | 'forbidden' | 'stale-base' | 'idempotency-mismatch' | 'rights-blocked' | 'refused' | 'rate-limited' | 'unavailable'

export interface CommandFailure { kind: CommandFailureKind; status: number; code: string | null; message: string; requestId: string | null }

export const FAILURE_MESSAGES: Readonly<Record<CommandFailureKind, string>> = Object.freeze({
  'session-expired': 'A sessão expirou. Entre novamente: o rascunho desta exceção fica guardado neste navegador.',
  'not-found': 'Este projeto não existe neste workspace.',
  forbidden: 'Esta sessão não tem permissão para alterar o projeto.',
  'stale-base': 'Outra pessoa já gravou uma versão mais nova. Releia o projeto e refaça a exceção sobre a versão atual; nada foi gravado.',
  'idempotency-mismatch': 'Esta chave de repetição já foi usada com outro conteúdo. Reabra o formulário e envie de novo.',
  'rights-blocked': 'Os direitos de uso de uma das mídias foram revogados. Nada foi gravado.',
  refused: 'O servidor recusou a exceção.',
  'rate-limited': 'O servidor pediu uma pausa. Tente novamente em instantes.',
  unavailable: 'Não foi possível concluir a operação. Nada foi aplicado sem confirmação do servidor.',
})

/** Never a stack, a body or a token: a closed kind, the published code and the request id. */
export function classifyCommandFailure(status: number, payload: { error?: { code?: string; message?: string; requestId?: string; details?: { reason?: string } } } | null): CommandFailure {
  const code = payload?.error?.code ?? null
  const reason = payload?.error?.details?.reason ?? null
  const requestId = payload?.error?.requestId ?? null
  const kind: CommandFailureKind =
    status === 401 ? 'session-expired'
    : status === 404 || code === 'PROJECT_NOT_FOUND' ? 'not-found'
    : status === 403 ? 'forbidden'
    : code === 'IDEMPOTENCY_PAYLOAD_MISMATCH' ? 'idempotency-mismatch'
    : code === 'VERSION_CONFLICT' || status === 409 ? 'stale-base'
    : code === 'ASSET_RIGHTS_BLOCKED' || reason === 'ASSET_RIGHTS_BLOCKED' ? 'rights-blocked'
    : status === 429 ? 'rate-limited'
    : status >= 500 || status === 0 ? 'unavailable'
    : 'refused'
  const detail = kind === 'refused' && payload?.error?.message ? ` ${payload.error.message}` : ''
  return { kind, status, code, message: `${FAILURE_MESSAGES[kind]}${detail}`, requestId }
}

/* -------------------------------------------------------------------------- */
/* Before / after                                                             */
/* -------------------------------------------------------------------------- */

export type IssueDelta = 'not-reported-now' | 'still-reported' | 'new'

export interface IssueComparisonRow { key: string; code: string; severity: IssueSeverityChip; range: IssueChip['range']; delta: IssueDelta }

/**
 * Compares the issues of the review BEFORE a Command with the review of the render made AFTER it. `not-reported-now` is the only state
 * that is not "still there": it says a new critic run on new pixels did not report the issue, and nothing else. It is never produced
 * without an after-review.
 */
export function compareIssues(before: readonly IssueChip[], after: readonly IssueChip[] | null): readonly IssueComparisonRow[] {
  if (after === null) return before.map((chip) => ({ key: chip.key, code: chip.code, severity: chip.severity, range: chip.range, delta: 'still-reported' as const }))
  const afterKeys = new Set(after.map((chip) => chip.key))
  const beforeKeys = new Set(before.map((chip) => chip.key))
  return [
    ...before.map((chip) => ({ key: chip.key, code: chip.code, severity: chip.severity, range: chip.range, delta: afterKeys.has(chip.key) ? 'still-reported' as const : 'not-reported-now' as const })),
    ...after.filter((chip) => !beforeKeys.has(chip.key)).map((chip) => ({ key: chip.key, code: chip.code, severity: chip.severity, range: chip.range, delta: 'new' as const })),
  ]
}

export const DELTA_LABELS: Readonly<Record<IssueDelta, string>> = Object.freeze({
  'not-reported-now': 'Não reportado no novo render',
  'still-reported': 'Ainda reportado',
  new: 'Novo no render',
})
