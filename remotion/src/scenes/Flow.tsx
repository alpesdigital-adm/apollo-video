import React from 'react';
import { InsertFrame, KineticText, Marker, compactText } from '../components/InsertPrimitives';

interface FlowStep {
  number: number;
  text: string;
}

interface FlowProps {
  steps: FlowStep[];
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const Flow: React.FC<FlowProps> = ({
  steps,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const visibleSteps = (steps || []).slice(0, format === '9:16' ? 4 : 5);

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="stage"
      align="center"
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: format === '9:16' ? 30 : 24,
        }}
      >
        {visibleSteps.map((step, index) => (
          <div
            key={index}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24 }}
          >
            <Marker stylePreset={stylePreset} size={format === '9:16' ? 62 : 58}>
              {step.number || index + 1}
            </Marker>
            <KineticText
              stylePreset={stylePreset}
              variant="title"
              align="left"
              maxChars={44}
              maxLines={1}
              baseSize={format === '9:16' ? 56 : 54}
              minSize={38}
              startDelay={index * 5}
            >
              {compactText(step.text, 44)}
            </KineticText>
          </div>
        ))}
      </div>
    </InsertFrame>
  );
};
