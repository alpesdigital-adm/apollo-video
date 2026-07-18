import type { Silence, Transcription, TranscriptionSegment } from './types/project'

export interface EditorialCut {
  startTime: number
  endTime: number
  reason: string
}

export function normalizeEditorialCuts(cuts: readonly EditorialCut[], duration: number): EditorialCut[] {
  const valid = cuts
    .map((cut) => ({
      startTime: Math.max(0, Number(cut.startTime)),
      endTime: Math.min(duration, Number(cut.endTime)),
      reason: String(cut.reason || 'editorial-cut').trim().slice(0, 240)
    }))
    .filter((cut) => Number.isFinite(cut.startTime) && Number.isFinite(cut.endTime) && cut.endTime - cut.startTime >= 0.08)
    .sort((left, right) => left.startTime - right.startTime)

  const merged: EditorialCut[] = []
  for (const cut of valid) {
    const previous = merged[merged.length - 1]
    if (previous && cut.startTime <= previous.endTime + 0.04) {
      previous.endTime = Math.max(previous.endTime, cut.endTime)
      previous.reason = `${previous.reason}; ${cut.reason}`.slice(0, 240)
    } else {
      merged.push({ ...cut })
    }
  }
  return merged
}

function wordIsRemoved(start: number, end: number, cuts: readonly EditorialCut[]) {
  const center = start + Math.max(0, end - start) / 2
  return cuts.some((cut) => center >= cut.startTime && center < cut.endTime)
}

export function applyEditorialCutsToTranscription(
  transcription: Transcription,
  cuts: readonly EditorialCut[]
): Transcription {
  const segments: TranscriptionSegment[] = []
  for (const segment of transcription.segments) {
    const words = segment.words.filter((word) => !wordIsRemoved(word.start, word.end, cuts))
    if (!words.length) continue
    const text = words.map((word) => word.word).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
    segments.push({
      id: segments.length,
      start: words[0].start,
      end: words[words.length - 1].end,
      text,
      words
    })
  }
  return {
    ...transcription,
    text: segments.map((segment) => segment.text).join(' '),
    segments
  }
}

// cutSilencesFromVideo protects speech by shaving this padding off both edges.
// Editorial ranges are expanded by the same amount so the requested word range
// remains exact after that protection is applied.
export function editorialCutsAsSilences(cuts: readonly EditorialCut[], fps: number, margin = 0.12): Silence[] {
  return cuts.map((cut) => {
    const startTime = Math.max(0, cut.startTime - margin)
    const endTime = cut.endTime + margin
    return {
      startTime,
      endTime,
      startFrame: Math.round(startTime * fps),
      endFrame: Math.round(endTime * fps),
      duration: endTime - startTime
    }
  })
}
