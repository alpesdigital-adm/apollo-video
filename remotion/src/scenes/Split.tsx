import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface SplitProps {
  title: string;
  content: string;
  panelColor?: string;
  format: '9:16' | '16:9';
  palette: any;
}

export const Split: React.FC<SplitProps> = ({
  title,
  content,
  panelColor,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const translateY = spring({
    frame,
    fps: config.fps,
    from: -400,
    to: 0,
    duration: 40,
    damp: 0.8,
  });

  const opacity = interpolate(
    frame,
    [0, 15, config.durationInFrames - 20, config.durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill style={{ opacity }}>
      <div
        style={{
          width: '100%',
          height: '50%',
          backgroundColor: panelColor || 'rgba(0, 0, 0, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px',
          boxSizing: 'border-box',
          transform: `translateY(${translateY}px)`,
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <h2
            style={{
              fontSize: '72px',
              fontWeight: 'bold',
              color: palette.text,
              margin: '0 0 20px 0',
            }}
          >
            {title}
          </h2>
          <p
            style={{
              fontSize: '48px',
              color: palette.text,
              margin: '0',
              opacity: 0.8,
              lineHeight: '1.4',
            }}
          >
            {content}
          </p>
        </div>
      </div>
      <div
        style={{
          width: '100%',
          height: '50%',
          position: 'absolute',
          bottom: 0,
          left: 0,
        }}
      />
    </AbsoluteFill>
  );
};
