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

  // Whisper pode entregar uma frase longa como um único segmento. Exibimos
  // blocos curtos para que a legenda nunca vire um parágrafo sobre o rosto.
  const words = (Array.isArray(subtitle.words) ? subtitle.words : [])
    .filter((word): word is Exclude<typeof word, string> => typeof word !== 'string');
  const activeWordIndex = words.findIndex((word) => currentTime >= word.start && currentTime < word.end);
  const resolvedWordIndex = activeWordIndex >= 0
    ? activeWordIndex
    : Math.max(0, words.findLastIndex((word) => word.start <= currentTime));
  const chunkStart = Math.floor(resolvedWordIndex / 8) * 8;
  const displayText = words.length
    ? words.slice(chunkStart, chunkStart + 8).map((word) => word.word).join(' ')
    : subtitle.text;

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
        alignItems: subtitle.anchor === 'top' ? 'flex-start' : 'flex-end',
        justifyContent: 'center',
        paddingTop: subtitle.anchor === 'top' ? '90px' : 0,
        paddingBottom: subtitle.anchor === 'top' ? 0 : '90px',
        opacity,
      }}
    >
      <div
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          padding: '16px 32px',
          borderRadius: '8px',
          maxWidth: '68%',
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
          {displayText}
        </div>
      </div>
    </AbsoluteFill>
  );
};
