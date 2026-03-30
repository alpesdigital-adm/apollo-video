import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import { SubtitleEntry, ColorPalette } from '../lib/types';

interface SubtitleTikTokProps {
  subtitle: SubtitleEntry;
  palette: ColorPalette;
  isVisible: boolean;
}

export const SubtitleTikTok: React.FC<SubtitleTikTokProps> = ({
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

  const words = subtitle.words || subtitle.text.split(' ');
  const duration = subtitle.endTime - subtitle.startTime;
  const timeInSubtitle = currentTime - subtitle.startTime;
  const wordDuration = duration / words.length;

  const opacity = interpolate(
    timeInSubtitle,
    [0, 0.1, duration - 0.1, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const currentWordIndex = Math.floor(timeInSubtitle / wordDuration);
  const wordTimeProgress = (timeInSubtitle % wordDuration) / wordDuration;

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: '20%',
        opacity,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          justifyContent: 'center',
          maxWidth: '90%',
          textAlign: 'center',
        }}
      >
        {words.map((word, index) => {
          const isCurrentWord = index === currentWordIndex;
          const scale = isCurrentWord
            ? 1 + wordTimeProgress * 0.2
            : 1;
          const color = isCurrentWord ? palette.accent : palette.text;
          const wordOpacity = isCurrentWord ? 1 : 0.6;

          return (
            <span
              key={index}
              style={{
                fontSize: '64px',
                fontWeight: 'bold',
                color,
                opacity: wordOpacity,
                transform: `scale(${scale})`,
                textShadow: '0 4px 12px rgba(0, 0, 0, 0.8)',
                transition: isCurrentWord ? 'none' : 'all 0.2s ease',
                whiteSpace: 'nowrap',
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
