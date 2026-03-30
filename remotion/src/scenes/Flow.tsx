import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface FlowStep {
  number: number;
  text: string;
}

interface FlowProps {
  steps: FlowStep[];
  format: '9:16' | '16:9';
  palette: any;
}

export const Flow: React.FC<FlowProps> = ({ steps, palette }) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const totalDuration = config.durationInFrames - 30;
  const stepDuration = totalDuration / steps.length;

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
        padding: '60px',
        opacity,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '40px',
          width: '100%',
          maxWidth: '600px',
        }}
      >
        {steps.map((step, index) => {
          const stepStartFrame = index * stepDuration;
          const stepEndFrame = stepStartFrame + stepDuration;

          const stepOpacity = interpolate(
            frame,
            [stepStartFrame, stepStartFrame + 10, stepEndFrame - 10, stepEndFrame],
            [0, 1, 1, 0.3],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
          );

          const scale = interpolate(
            frame,
            [stepStartFrame, stepStartFrame + 15],
            [0.8, 1],
            { extrapolateRight: 'clamp' }
          );

          const lineOpacity = index < steps.length - 1
            ? interpolate(
              frame,
              [stepEndFrame - 20, stepEndFrame],
              [0, 1],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            )
            : 0;

          return (
            <div key={index}>
              <div
                style={{
                  display: 'flex',
                  gap: '30px',
                  alignItems: 'center',
                  opacity: stepOpacity,
                  transform: `scale(${scale})`,
                  transformOrigin: 'left center',
                }}
              >
                <div
                  style={{
                    width: '80px',
                    height: '80px',
                    borderRadius: '50%',
                    backgroundColor: palette.accent,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: '48px',
                      fontWeight: 'bold',
                      color: palette.background,
                    }}
                  >
                    {step.number}
                  </span>
                </div>

                <p
                  style={{
                    fontSize: '44px',
                    color: palette.text,
                    margin: '0',
                    lineHeight: '1.3',
                  }}
                >
                  {step.text}
                </p>
              </div>

              {index < steps.length - 1 && (
                <div
                  style={{
                    marginLeft: '40px',
                    marginTop: '20px',
                    marginBottom: '20px',
                    width: '3px',
                    height: '40px',
                    backgroundColor: palette.accent,
                    opacity: lineOpacity,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
