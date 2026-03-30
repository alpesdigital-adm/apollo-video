import React from 'react';
import { SubtitleEntry, ColorPalette } from '../lib/types';
import { SubtitleTikTok } from './SubtitleTikTok';
import { SubtitleStandard } from './SubtitleStandard';
import { useCurrentFrame, useVideoConfig } from 'remotion';

interface SubtitleOverlayProps {
  subtitles: SubtitleEntry[];
  format: '9:16' | '16:9';
  palette: ColorPalette;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  subtitles,
  format,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const currentTime = frame / config.fps;

  const currentSubtitle = subtitles.find(
    (sub) => currentTime >= sub.startTime && currentTime < sub.endTime
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
