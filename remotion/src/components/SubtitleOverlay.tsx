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
  // 0-1. 1 = a stage typographic scene owns the frame, so the karaoke subtitle
  // displaces to the TOP of the head (never colliding with the centered
  // statement); 0 = normal bottom placement. Values in between = the ~8-frame
  // positional crossfade (bottom fades out / top fades in). Defaults to 0.
  topFactor?: number;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  subtitles,
  format,
  palette,
  layoutSegments,
  subtitleStyle,
  topFactor = 0,
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
    // split-50's centered two-word mode keeps precedence — it is already on the
    // seam and must not be displaced.
    if (activeSegment?.layout === 'split-50') {
      return (
        <SubtitleTikTok
          subtitle={currentSubtitle}
          palette={palette}
          isVisible={!!currentSubtitle}
          mode="two-word-center"
          subtitleStyle={subtitleStyle}
        />
      );
    }

    const tf = Math.max(0, Math.min(1, topFactor));
    // Positional crossfade: render the bottom copy (fading out) and the top copy
    // (fading in) as separate nodes so the subtitle appears to move between the
    // two anchors without sliding. Only one is meaningfully visible at rest.
    return (
      <>
        {tf < 1 && (
          <SubtitleTikTok
            subtitle={currentSubtitle}
            palette={palette}
            isVisible={!!currentSubtitle}
            mode="default"
            subtitleStyle={subtitleStyle}
            placement="bottom"
            placementOpacity={1 - tf}
          />
        )}
        {tf > 0 && (
          <SubtitleTikTok
            subtitle={currentSubtitle}
            palette={palette}
            isVisible={!!currentSubtitle}
            mode="default"
            subtitleStyle={subtitleStyle}
            placement="top"
            placementOpacity={tf}
          />
        )}
      </>
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
