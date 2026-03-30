/**
 * Timing constants and type definitions
 */

import type { SubtitleEntry } from './project'

export const FPS = 30

export type ConvertStartLeg = (startLeg: number, subtitles: SubtitleEntry[]) => number
