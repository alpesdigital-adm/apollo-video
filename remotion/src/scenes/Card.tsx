import React from 'react';
import { AccentRule, InsertFrame, Kicker, Panel, SmartText, getInsertStyle } from '../components/InsertPrimitives';

interface CardProps {
  number: number;
  icon?: string;
  title: string;
  description?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const Card: React.FC<CardProps> = ({
  number,
  icon,
  title,
  description,
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
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} align="center" maxWidth={format === '9:16' ? 820 : 980}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 24 }}>
          <div
            style={{
              width: 78,
              height: 78,
              borderRadius: 22,
              background: style.accent,
              color: style.accentText,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 36,
              fontWeight: 900,
              flexShrink: 0,
            }}
          >
            {icon || number || '•'}
          </div>
          <Kicker stylePreset={stylePreset}>Insight</Kicker>
        </div>
        <SmartText
          stylePreset={stylePreset}
          variant="title"
          maxChars={58}
          maxLines={2}
          baseSize={format === '9:16' ? 58 : 66}
          minSize={36}
        >
          {title}
        </SmartText>
        {description && (
          <>
            <AccentRule stylePreset={stylePreset} />
            <SmartText
              stylePreset={stylePreset}
              variant="muted"
              maxChars={88}
              maxLines={3}
              baseSize={34}
              minSize={27}
            >
              {description}
            </SmartText>
          </>
        )}
      </Panel>
    </InsertFrame>
  );
};
