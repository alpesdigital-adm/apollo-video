/**
 * W70 readiness. What the review panel says about a review whose render was carried from an earlier Version because nothing it is drawn from
 * changed. Pure: the page renders what this returns, and the tests read it without a browser.
 *
 * An inherited approval is NEVER shown as a human acknowledgement made on this Version: the headline says it was inherited automatically, from
 * which Version, and that the content is identical; the detail names the review it came from, the decision that re-bound it and the content
 * address that proved the inputs equal. A review that was carried without an approval (the source had none to re-bind) says so too.
 */
export interface CarriedFromView {
  versionId: string
  reviewId: string
  reviewHash: string
  decisionId: string | null
  renderContentHash: string
  /** The person who acknowledged the SOURCE review, on `versionId`; null when the carry re-bound no approval. */
  acknowledgedBy?: { type: string; id: string; at: string } | null
}

export interface CarriedReviewInput {
  carriedFrom?: CarriedFromView
  /** The review has been acknowledged (by a person, or by the approval the carry re-bound). */
  warningsAcknowledged: boolean
}

export interface CarriedReviewView {
  /** `approval-carried`: a person's approval of the earlier Version was re-bound. `render-carried`: only the render (and its pending review) was. */
  kind: 'approval-carried' | 'render-carried'
  headline: string
  detail: string
  /** A person acknowledged the warnings of THIS Version after the render was carried (an approval of its own, not the inherited one). */
  acknowledgedOnThisVersion: boolean
}

const short = (hash: string) => hash.slice(0, 12)

export function describeCarriedReview(review: Readonly<CarriedReviewInput>): CarriedReviewView | null {
  const carried = review.carriedFrom
  if (!carried) return null
  if (carried.decisionId !== null) {
    return Object.freeze({
      kind: 'approval-carried' as const,
      headline: `Aprovação herdada automaticamente da versão ${carried.versionId} — conteúdo idêntico`,
      detail: `Nenhuma pessoa reconheceu as ressalvas desta versão: a aprovação é a do laudo ${short(carried.reviewHash)} da versão ${carried.versionId}${carried.acknowledgedBy ? ` (reconhecida lá por ${carried.acknowledgedBy.id} em ${carried.acknowledgedBy.at})` : ''}, religada pela decisão ${carried.decisionId} porque o conteúdo do render não mudou (endereço ${short(carried.renderContentHash)}).`,
      acknowledgedOnThisVersion: false,
    })
  }
  return Object.freeze({
    kind: 'render-carried' as const,
    headline: `Render herdado automaticamente da versão ${carried.versionId} — conteúdo idêntico`,
    detail: review.warningsAcknowledged
      ? `O render e o laudo ${short(carried.reviewHash)} vêm da versão ${carried.versionId} (endereço ${short(carried.renderContentHash)}); a herança não aprovou nada: as ressalvas foram reconhecidas por uma pessoa depois, nesta versão.`
      : `O render e o laudo ${short(carried.reviewHash)} vêm da versão ${carried.versionId} (endereço ${short(carried.renderContentHash)}); a herança não aprovou nada: as ressalvas continuam para uma pessoa decidir.`,
    acknowledgedOnThisVersion: review.warningsAcknowledged,
  })
}
