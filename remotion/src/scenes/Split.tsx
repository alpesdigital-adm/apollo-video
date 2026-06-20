import React from 'react';
import { InsertFrame, Kicker, Panel, SmartText, getInsertStyle } from '../components/InsertPrimitives';

interface SplitProps {
  title: string;
  content: string;
  topText?: string;
  bottomText?: string;
  panelColor?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const Split: React.FC<SplitProps> = ({
  title,
  content,
  topText,
  bottomText,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const style = getInsertStyle(stylePreset);
  const first = topText || title;
  const second = bottomText || content;

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} align="center" maxWidth={format === '9:16' ? 880 : 1180}>
        <Kicker stylePreset={stylePreset}>Antes de decidir</Kicker>
        <div style={{ display: 'grid', gap: 18 }}>
          {[first, second].filter(Boolean).map((text, index) => (
            <div
              key={index}
              style={{
                borderRadius: Math.max(14, style.radius - 10),
                border: `1px solid ${index === 0 ? style.border : style.accent}`,
                background: index === 0 ? 'rgba(255,255,255,0.06)' : style.panelSoft,
                padding: '26px 30px',
              }}
            >
              <SmartText
                stylePreset={stylePreset}
                variant={index === 1 ? 'accent' : 'title'}
                maxChars={66}
                maxLines={2}
                baseSize={format === '9:16' ? 44 : 52}
                minSize={30}
              >
                {text}
              </SmartText>
            </div>
          ))}
        </div>
      </Panel>
    </InsertFrame>
  );
};
