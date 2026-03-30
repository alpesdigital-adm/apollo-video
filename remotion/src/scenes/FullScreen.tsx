import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface FullScreenProps {
  title: string;
  subtitle?: string;
  backgroundColor?: string;
  textColor?: string;
  format: '9:16' | '16:9';
  palette: any;
}

export const FullScreen: React.FC<FullScreenProps> = ({
  title,
  subtitle,
  backgroundColor,
  textColor,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const scale = spring({
    frame,
    fps: config.fps,
    from: 0.8,
    to: 1,
    duration: 30,
    damp: 0.8,
  });

  const opacity = interpolate(
    frame,
    [0, 20, config.durationInFrames - 20, config.durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: backgroundColor || palette.primary,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity,
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '96px',
            fontWeight: 'bold',
            color: textColor || palette.text,
            margin: '0 0 20px 0',
            textShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            style={{
              fontSize: '48px',
              color: textColor || palette.text,
              margin: '0',
              opacity: 0.8,
              textShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </AbsoluteFill>
  );
};
