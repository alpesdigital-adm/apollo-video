/**
 * COLD OPEN (Fase 3) — helpers PUROS (sem deps de node/fs), compartilhados entre
 * o servidor (rotas + engine) e o cliente (player).
 *
 * Contrato: `EditPlan.coldOpen = { fromFrame, toFrame }` é uma JANELA na timeline
 * FONTE (o vídeo base sem deslocamento). Duração fixa em 3-8s. O DESLOCAMENTO da
 * montagem (offset de `len` frames em cenas/legendas/segmentos/punch-ins) acontece
 * só na construção dos inputProps — o banco e as batidas continuam na fonte.
 */

import { buildBeats } from './beats'
import type { SubtitleEntry } from './types/project'
import type { Scene } from './types/scene'

export const COLD_OPEN_MIN_SECONDS = 3
export const COLD_OPEN_MAX_SECONDS = 8

export interface ColdOpenWindow {
  fromFrame: number
  toFrame: number
}

/**
 * Normaliza/valida uma janela de cold open para o intervalo [3s, 8s], dentro dos
 * limites [0, durationFrames]. Retorna null quando a entrada é inviável.
 * `durationFrames` é a duração da timeline FONTE (sem o offset do cold open).
 */
export function clampColdOpenWindow(
  fromFrame: unknown,
  toFrame: unknown,
  fps: number,
  durationFrames?: number
): ColdOpenWindow | null {
  const dur = Number.isFinite(durationFrames) && (durationFrames as number) > 0
    ? Math.round(durationFrames as number)
    : 0
  let a = Math.round(Number(fromFrame))
  let b = Math.round(Number(toFrame))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null

  const safeFps = fps > 0 ? fps : 30
  const minLen = Math.max(1, Math.round(safeFps * COLD_OPEN_MIN_SECONDS))
  const maxLen = Math.max(minLen, Math.round(safeFps * COLD_OPEN_MAX_SECONDS))

  a = Math.max(0, a)
  if (dur) a = Math.min(a, Math.max(0, dur - 1))

  let len = b - a
  if (!Number.isFinite(len) || len < minLen) len = minLen
  else if (len > maxLen) len = maxLen
  b = a + len

  if (dur && b > dur) {
    b = dur
    a = Math.max(0, b - len)
    len = b - a
  }

  if (len < 1 || b <= a) return null
  return { fromFrame: a, toFrame: b }
}

/**
 * Deriva a janela do cold open a partir de uma batida (índice de legenda).
 * Regra: se uma CENA cobre a batida, usa o span de frames dessa cena; senão usa
 * [startFrame da batida, endFrame da batida + 1]. O resultado é sempre clampado
 * para 3-8s dentro de [0, durationFrames].
 */
export function computeColdOpenWindow(
  beatIndex: number,
  subtitles: SubtitleEntry[],
  scenes: Scene[],
  fps: number,
  durationFrames?: number
): ColdOpenWindow | null {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return null
  if (typeof beatIndex !== 'number' || beatIndex < 0 || beatIndex > subtitles.length - 1) {
    return null
  }

  const beats = buildBeats(subtitles, scenes)
  const beat = beats[beatIndex]
  if (!beat) return null

  let from: number
  let to: number
  const coveringScene = beat.sceneId ? scenes.find((s) => s.id === beat.sceneId) : null
  if (
    coveringScene &&
    typeof coveringScene.startFrame === 'number' &&
    typeof coveringScene.endFrame === 'number'
  ) {
    from = coveringScene.startFrame
    to = coveringScene.endFrame
  } else {
    from = beat.startFrame
    to = beat.endFrame + 1
  }

  return clampColdOpenWindow(from, to, fps, durationFrames)
}
