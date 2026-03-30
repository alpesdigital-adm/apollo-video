import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import { SubtitleEntry, ColorPalette } from '../lib/types';

interface SubtitleStandardProps {
  subtitle: SubtitleEntry;
  palette: ColorPalette;
  isVisible: boolean;
}

export const SubtitleStandard: React.FC<SubtitleStandardProps> = ({
  subtitle,
  palette,
  isVisible,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const currentTime = frame / config.fps;

  if (!isVisible) {
    return null;
  }

  const duration = subtitle.endTime - subtitle.startTime;
  const timeInSubtitle = currentTime - subtitle.startTime;

  const opacity = interpolate(
    timeInSubtitle,
    [0, 0.2, duration - 0.2, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: '40px',
        opacity,
      }}
    >
      <div
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          padding: '16px 32px',
          borderRadius: '8px',
          maxWidth: '80%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: '48px',
            fontWeight: '500',
            color: palette.text,
            fontFamily: 'Arial, sans-serif',
            lineHeight: '1.4',
          }}
        >
          {subtitle.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
