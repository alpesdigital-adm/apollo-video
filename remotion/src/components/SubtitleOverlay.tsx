import React from 'react';
import { SubtitleEntry, ColorPalette, LayoutSegment } from '../lib/types';
import { SubtitleTikTok } from './SubtitleTikTok';
import { SubtitleStandard } from './SubtitleStandard';
import { findActiveLayoutSegment } from './LayoutSegmentLayer';
import { useCurrentFrame, useVideoConfig } from 'remotion';

interface SubtitleOverlayProps {
  subtitles: SubtitleEntry[];
  format: '9:16' | '16:9';
  palette: ColorPalette;
  layoutSegments?: LayoutSegment[];
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  subtitles,
  format,
  palette,
  layoutSegments,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const currentTime = frame / config.fps;
  const activeSegment = findActiveLayoutSegment(layoutSegments, frame);

  const currentSubtitle = subtitles.find(
    (sub) => {
      if (typeof sub.startFrame === 'number' && typeof sub.endFrame === 'number') {
        return frame >= sub.startFrame && frame < sub.endFrame;
      }

      return currentTime >= sub.startTime && currentTime < sub.endTime;
    }
  );

  if (!currentSubtitle) {
    return null;
  }

  if (format === '9:16') {
    return (
      <SubtitleTikTok
        subtitle={currentSubtitle}
        palette={palette}
        isVisible={!!currentSubtitle}
        mode={activeSegment?.layout === 'split-50' ? 'two-word-center' : 'default'}
      />
    );
  }

  return (
    <SubtitleStandard
      subtitle={currentSubtitle}
      palette={palette}
      isVisible={!!currentSubtitle}
    />
  );
};
