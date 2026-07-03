import React from 'react';
import { SubtitleEntry, ColorPalette, LayoutSegment, SubtitleStyle } from '../lib/types';
import { SubtitleTikTok } from './SubtitleTikTok';
import { SubtitleStandard } from './SubtitleStandard';
import { findActiveLayoutSegment } from './LayoutSegmentLayer';
import { useCurrentFrame, useVideoConfig } from 'remotion';

interface SubtitleOverlayProps {
  subtitles: SubtitleEntry[];
  format: '9:16' | '16:9';
  palette: ColorPalette;
  layoutSegments?: LayoutSegment[];
  subtitleStyle?: SubtitleStyle;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  subtitles,
  format,
  palette,
  layoutSegments,
  subtitleStyle,
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
        subtitleStyle={subtitleStyle}
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
