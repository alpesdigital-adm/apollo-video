import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface CTAProps {
  text: string;
  highlightWord?: string;
  emoji?: string;
  format: '9:16' | '16:9';
  palette: any;
}

export const CTA: React.FC<CTAProps> = ({
  text,
  highlightWord,
  emoji,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const opacity = interpolate(
    frame,
    [0, 15, config.durationInFrames - 20, config.durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const pulseScale = 1 + Math.sin((frame / config.fps) * Math.PI * 2) * 0.15;

  const highlightIndex = highlightWord
    ? text.split(' ').findIndex(word => word.toLowerCase() === highlightWord.toLowerCase())
    : -1;

  const words = text.split(' ');

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '40px',
        padding: '60px',
        opacity,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h2
          style={{
            fontSize: '80px',
            fontWeight: 'bold',
            color: palette.text,
            margin: '0 0 30px 0',
            lineHeight: '1.3',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '20px',
            justifyContent: 'center',
          }}
        >
          {words.map((word, idx) => (
            <span
              key={idx}
              style={{
                color: idx === highlightIndex ? palette.accent : palette.text,
                transform: idx === highlightIndex ? `scale(${pulseScale})` : 'scale(1)',
                transition: 'transform 0.1s ease',
              }}
            >
              {word}
            </span>
          ))}
        </h2>
      </div>

      {emoji && (
        <div
          style={{
            fontSize: '120px',
            animation: `bounce 1s infinite`,
            transform: `scale(${pulseScale})`,
          }}
        >
          {emoji}
        </div>
      )}

      <style>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-20px); }
        }
      `}</style>
    </AbsoluteFill>
  );
};
