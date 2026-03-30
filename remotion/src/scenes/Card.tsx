import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface CardProps {
  number: number;
  icon?: string;
  title: string;
  description?: string;
  format: '9:16' | '16:9';
  palette: any;
}

export const Card: React.FC<CardProps> = ({
  number,
  icon,
  title,
  description,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const scale = spring({
    frame,
    fps: config.fps,
    from: 0.5,
    to: 1,
    duration: 35,
    damp: 0.8,
  });

  const opacity = interpolate(
    frame,
    [0, 15, config.durationInFrames - 20, config.durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity,
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          border: `2px solid ${palette.accent}`,
          borderRadius: '24px',
          padding: '40px',
          maxWidth: '400px',
          width: '90%',
          textAlign: 'center',
          backdropFilter: 'blur(10px)',
        }}
      >
        <div
          style={{
            fontSize: '24px',
            marginBottom: '20px',
            minHeight: '40px',
          }}
        >
          {icon || '✨'}
        </div>

        <div
          style={{
            fontSize: '80px',
            fontWeight: 'bold',
            color: palette.accent,
            margin: '20px 0',
          }}
        >
          {number}
        </div>

        <h3
          style={{
            fontSize: '48px',
            fontWeight: 'bold',
            color: palette.text,
            margin: '20px 0 10px 0',
          }}
        >
          {title}
        </h3>

        {description && (
          <p
            style={{
              fontSize: '32px',
              color: palette.text,
              margin: '10px 0 0 0',
              opacity: 0.7,
              lineHeight: '1.4',
            }}
          >
            {description}
          </p>
        )}
      </div>
    </AbsoluteFill>
  );
};
