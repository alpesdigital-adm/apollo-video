import React from 'react';
import { InsertFrame, Kicker, Panel, SmartText, compactText, getInsertStyle } from '../components/InsertPrimitives';

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
  const style = getInsertStyle(stylePreset);
  const visibleSteps = (steps || []).slice(0, format === '9:16' ? 4 : 5);

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} align="center" maxWidth={format === '9:16' ? 900 : 1120}>
        <Kicker stylePreset={stylePreset}>Checklist</Kicker>
        <div style={{ display: 'grid', gap: 16 }}>
          {visibleSteps.map((step, index) => (
            <div
              key={index}
              style={{
                display: 'grid',
                gridTemplateColumns: '58px 1fr',
                gap: 18,
                alignItems: 'center',
                border: `1px solid ${style.border}`,
                borderRadius: Math.max(14, style.radius - 12),
                background: index === 0 ? style.panelSoft : 'rgba(255,255,255,0.05)',
                padding: '18px 22px',
              }}
            >
              <div
                style={{
                  width: 58,
                  height: 58,
                  borderRadius: 18,
                  background: style.accent,
                  color: style.accentText,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 28,
                  fontWeight: 900,
                }}
              >
                {step.number || index + 1}
              </div>
              <SmartText
                stylePreset={stylePreset}
                variant="body"
                maxChars={54}
                maxLines={2}
                baseSize={format === '9:16' ? 34 : 38}
                minSize={26}
              >
                {compactText(step.text, 54)}
              </SmartText>
            </div>
          ))}
        </div>
      </Panel>
    </InsertFrame>
  );
};
