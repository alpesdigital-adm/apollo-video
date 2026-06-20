import React from 'react';
import { InsertFrame, Kicker, Panel, SmartText, getInsertStyle } from '../components/InsertPrimitives';

interface NumberProps {
  value: number | string;
  label?: string;
  prefix?: string;
  suffix?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const Number: React.FC<NumberProps> = ({
  value,
  label,
  prefix,
  suffix,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const style = getInsertStyle(stylePreset);
  const displayValue = `${prefix || ''}${value || ''}${suffix || ''}`.trim();

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} align="center" maxWidth={format === '9:16' ? 820 : 980}>
        <Kicker stylePreset={stylePreset}>Criterio</Kicker>
        <div
          style={{
            display: 'inline-flex',
            borderRadius: 999,
            background: style.accent,
            color: style.accentText,
            padding: '16px 28px',
            marginBottom: 28,
            fontSize: 38,
            fontWeight: 900,
            lineHeight: 1,
          }}
        >
          {displayValue || '1'}
        </div>
        {label && (
          <SmartText
            stylePreset={stylePreset}
            variant="title"
            align="center"
            maxChars={66}
            maxLines={2}
            baseSize={format === '9:16' ? 54 : 64}
            minSize={34}
          >
            {label}
          </SmartText>
        )}
      </Panel>
    </InsertFrame>
  );
};
