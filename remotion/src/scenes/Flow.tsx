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
      zone="top"
      align="left"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: format === '9:16' ? 26 : 22 }}>
        {visibleSteps.map((step, index) => (
          <div key={index} style={{ display: 'flex', alignItems: 'flex-start', gap: 22 }}>
            <div style={{ paddingTop: 2 }}>
              <Marker stylePreset={stylePreset} size={format === '9:16' ? 44 : 50}>
                {step.number || index + 1}
              </Marker>
            </div>
            <div style={{ flex: 1 }}>
              <KineticText
                stylePreset={stylePreset}
                variant="title"
                align="left"
                maxChars={54}
                maxLines={2}
                baseSize={format === '9:16' ? 42 : 48}
                minSize={30}
                startDelay={index * 5}
              >
                {compactText(step.text, 54)}
              </KineticText>
            </div>
          </div>
        ))}
      </div>
    </InsertFrame>
  );
};
