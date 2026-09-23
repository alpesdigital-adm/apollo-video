import type { LayoutSegment, SubtitleEntry } from './types';

type ResolvedSubtitlePlacement = 'top' | 'bottom' | 'center';

export interface ResolvedSubtitleLayer {
  subtitle: SubtitleEntry;
  sourceIndex: number;
  placement: ResolvedSubtitlePlacement;
  placementOpacity: number;
  mode: 'default' | 'two-word-center';
}

interface ResolveActiveSubtitleLayersInput {
  subtitles: readonly SubtitleEntry[];
  frame: number;
  fps: number;
  format: '9:16' | '16:9';
  activeLayout?: LayoutSegment['layout'];
  topFactor?: number;
  hideFactor?: number;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

export const resolveActiveSubtitleLayers = ({
  subtitles,
  frame,
  fps,
  format,
  activeLayout,
  topFactor = 0,
  hideFactor = 0,
}: ResolveActiveSubtitleLayersInput): readonly ResolvedSubtitleLayer[] => {
  const currentTime = frame / fps;
  const selected: Array<{
    subtitle: SubtitleEntry;
    sourceIndex: number;
    anchor: 'top' | 'bottom';
  }> = [];
  let hasTop = false;
  let hasBottom = false;

  for (let sourceIndex = 0; sourceIndex < subtitles.length; sourceIndex += 1) {
    const subtitle = subtitles[sourceIndex];
    const active =
      typeof subtitle.startFrame === 'number' && typeof subtitle.endFrame === 'number'
        ? frame >= subtitle.startFrame && frame < subtitle.endFrame
        : currentTime >= subtitle.startTime && currentTime < subtitle.endTime;
    if (!active) {
      continue;
    }

    const anchor = subtitle.anchor === 'top' ? 'top' : 'bottom';
    if ((anchor === 'top' && hasTop) || (anchor === 'bottom' && hasBottom)) {
      continue;
    }

    selected.push({ subtitle, sourceIndex, anchor });
    hasTop = hasTop || anchor === 'top';
    hasBottom = hasBottom || anchor === 'bottom';
    if (hasTop && hasBottom) {
      break;
    }
  }

  const hf = clampUnit(hideFactor);
  if (selected.length === 0 || hf >= 1) {
    return Object.freeze([]);
  }

  if (format === '9:16' && activeLayout === 'split-50') {
    const first = selected[0];
    return Object.freeze([
      Object.freeze({
        subtitle: first.subtitle,
        sourceIndex: first.sourceIndex,
        placement: 'center' as const,
        placementOpacity: 1,
        mode: 'two-word-center' as const,
      }),
    ]);
  }

  const candidates: ResolvedSubtitleLayer[] = [];
  for (const item of selected) {
    if (format === '16:9' || item.anchor === 'top') {
      candidates.push({
        subtitle: item.subtitle,
        sourceIndex: item.sourceIndex,
        placement: item.anchor,
        placementOpacity: 1 - hf,
        mode: 'default',
      });
      continue;
    }

    const tf = clampUnit(topFactor);
    const bottomOpacity = tf < 0.5 ? (1 - tf * 2) * (1 - hf) : 0;
    const topOpacity = tf >= 0.5 ? (tf - 0.5) * 2 * (1 - hf) : 0;
    if (bottomOpacity > 0.01) {
      candidates.push({
        subtitle: item.subtitle,
        sourceIndex: item.sourceIndex,
        placement: 'bottom',
        placementOpacity: bottomOpacity,
        mode: 'default',
      });
    } else if (topOpacity > 0.01) {
      candidates.push({
        subtitle: item.subtitle,
        sourceIndex: item.sourceIndex,
        placement: 'top',
        placementOpacity: topOpacity,
        mode: 'default',
      });
    }
  }

  const occupied = new Set<ResolvedSubtitlePlacement>();
  return Object.freeze(
    candidates
      .sort((left, right) => left.sourceIndex - right.sourceIndex)
      .filter((candidate) => {
        if (occupied.has(candidate.placement)) {
          return false;
        }
        occupied.add(candidate.placement);
        return true;
      })
      .map((candidate) => Object.freeze(candidate)),
  );
};
