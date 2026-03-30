import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface NumberProps {
  value: number;
  label?: string;
  prefix?: string;
  suffix?: string;
  format: '9:16' | '16:9';
  palette: any;
}

export const Number: React.FC<NumberProps> = ({
  value,
  label,
  prefix,
  suffix,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const scale = spring({
    frame,
    fps: config.fps,
    from: 0.3,
    to: 1,
    duration: 40,
    damp: 0.8,
  });

  const countFrame = interpolate(
    frame,
    [0, 40, config.durationInFrames],
    [0, value, value],
    { extrapolateRight: 'clamp' }
  );

  const displayNumber = Math.round(countFrame);

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
        <div
          style={{
            fontSize: '180px',
            fontWeight: 'bold',
            color: palette.accent,
            margin: '0',
            lineHeight: '1',
          }}
        >
          <span>{prefix}</span>
          {displayNumber}
          <span>{suffix}</span>
        </div>

        {label && (
          <p
            style={{
              fontSize: '64px',
              color: palette.text,
              margin: '40px 0 0 0',
              opacity: 0.8,
            }}
          >
            {label}
          </p>
        )}
      </div>
    </AbsoluteFill>
  );
};
