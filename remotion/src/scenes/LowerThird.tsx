import React from 'react';
import { InsertFrame, Kicker, Panel, SmartText } from '../components/InsertPrimitives';

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
  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      placement="bottom"
      scrim={false}
    >
      <Panel stylePreset={stylePreset} soft maxWidth={format === '9:16' ? 840 : 980}>
        <Kicker stylePreset={stylePreset}>Contexto</Kicker>
        <SmartText
          stylePreset={stylePreset}
          variant="title"
          maxChars={54}
          maxLines={2}
          baseSize={format === '9:16' ? 54 : 60}
          minSize={36}
        >
          {title}
        </SmartText>
        {subtitle && (
          <div style={{ marginTop: 14 }}>
            <SmartText
              stylePreset={stylePreset}
              variant="muted"
              maxChars={74}
              maxLines={2}
              baseSize={32}
              minSize={26}
            >
              {subtitle}
            </SmartText>
          </div>
        )}
      </Panel>
    </InsertFrame>
  );
};
