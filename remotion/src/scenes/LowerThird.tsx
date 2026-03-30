import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface LowerThirdProps {
  title: string;
  subtitle?: string;
  accentColor?: string;
  format: '9:16' | '16:9';
  palette: any;
}

export const LowerThird: React.FC<LowerThirdProps> = ({
  title,
  subtitle,
  accentColor,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const translateX = spring({
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
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'flex-start',
        opacity,
      }}
    >
      <div
        style={{
          transform: `translateX(${translateX}px)`,
          padding: '40px',
          width: '100%',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '20px',
          }}
        >
          <div
            style={{
              width: '8px',
              height: '120px',
              backgroundColor: accentColor || palette.accent,
              borderRadius: '4px',
            }}
          />
          <div>
            <h2
              style={{
                fontSize: '64px',
                fontWeight: 'bold',
                color: palette.text,
                margin: '0 0 10px 0',
              }}
            >
              {title}
            </h2>
            {subtitle && (
              <p
                style={{
                  fontSize: '40px',
                  color: palette.text,
                  margin: '0',
                  opacity: 0.8,
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
