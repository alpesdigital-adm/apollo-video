import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface StickFiguresProps {
  leftCaption?: string;
  rightCaption?: string;
  leftFigureColor?: string;
  rightFigureColor?: string;
  format: '9:16' | '16:9';
  palette: any;
}

const StickFigureSVG: React.FC<{
  color: string;
  scale: number;
}> = ({ color, scale }) => (
  <svg
    width={200 * scale}
    height={240 * scale}
    viewBox="0 0 200 240"
    style={{ transform: `scale(${scale})` }}
  >
    <circle cx="100" cy="40" r="25" fill={color} strokeWidth="2" />
    <line x1="100" y1="65" x2="100" y2="130" stroke={color} strokeWidth="3" />
    <line x1="100" y1="85" x2="70" y2="105" stroke={color} strokeWidth="3" />
    <line x1="100" y1="85" x2="130" y2="105" stroke={color} strokeWidth="3" />
    <line x1="100" y1="130" x2="75" y2="180" stroke={color} strokeWidth="3" />
    <line x1="100" y1="130" x2="125" y2="180" stroke={color} strokeWidth="3" />
  </svg>
);

export const StickFigures: React.FC<StickFiguresProps> = ({
  leftCaption,
  rightCaption,
  leftFigureColor,
  rightFigureColor,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const leftScale = spring({
    frame,
    fps: config.fps,
    from: 0,
    to: 1,
    duration: 35,
    damp: 0.8,
  });

  const rightScale = spring({
    frame: Math.max(0, frame - 10),
    fps: config.fps,
    from: 0,
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
        gap: '60px',
        opacity,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '30px',
          opacity: leftScale,
        }}
      >
        <StickFigureSVG
          color={leftFigureColor || palette.accent}
          scale={1}
        />
        {leftCaption && (
          <p
            style={{
              fontSize: '44px',
              color: palette.text,
              margin: '0',
              textAlign: 'center',
              maxWidth: '200px',
            }}
          >
            {leftCaption}
          </p>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '30px',
          opacity: rightScale,
        }}
      >
        <StickFigureSVG
          color={rightFigureColor || palette.secondary}
          scale={1}
        />
        {rightCaption && (
          <p
            style={{
              fontSize: '44px',
              color: palette.text,
              margin: '0',
              textAlign: 'center',
              maxWidth: '200px',
            }}
          >
            {rightCaption}
          </p>
        )}
      </div>
    </AbsoluteFill>
  );
};
