import React from 'react';
import { InsertFrame, KineticText, getInsertStyle } from '../components/InsertPrimitives';

interface LowerThirdProps {
  title: string;
  subtitle?: string;
  accentColor?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const LowerThird: React.FC<LowerThirdProps> = ({
  title,
  subtitle,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const style = getInsertStyle(stylePreset);

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="lower"
      align="left"
    >
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 18 }}>
        <div
          style={{
            width: 6,
            borderRadius: 999,
            background: style.accent,
            flexShrink: 0,
          }}
        />
        <div>
          <KineticText
            stylePreset={stylePreset}
            variant="title"
            align="left"
            maxChars={44}
            maxLines={1}
            baseSize={format === '9:16' ? 46 : 52}
            minSize={34}
          >
            {title}
          </KineticText>
          {subtitle && (
            <div style={{ marginTop: 8 }}>
              <KineticText
                stylePreset={stylePreset}
                variant="muted"
                align="left"
                maxChars={64}
                maxLines={1}
                baseSize={30}
                minSize={24}
                startDelay={4}
              >
                {subtitle}
              </KineticText>
            </div>
          )}
        </div>
      </div>
    </InsertFrame>
  );
};
