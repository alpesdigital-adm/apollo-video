import React from 'react';
import { InsertFrame, Kicker, Panel, SmartText, getInsertStyle } from '../components/InsertPrimitives';

interface SplitVerticalProps {
  leftLabel: string;
  rightLabel: string;
  leftContent: string;
  rightContent: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const SplitVertical: React.FC<SplitVerticalProps> = ({
  leftLabel,
  rightLabel,
  leftContent,
  rightContent,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const style = getInsertStyle(stylePreset);
  const vertical = format === '9:16';

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} align="center" maxWidth={vertical ? 900 : 1240}>
        <Kicker stylePreset={stylePreset}>Comparativo</Kicker>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: vertical ? '1fr' : '1fr 1fr',
            gap: vertical ? 14 : 22,
            alignItems: 'stretch',
          }}
        >
          {[
            { label: leftLabel || 'Cenario', content: leftContent },
            { label: rightLabel || 'Decisao', content: rightContent },
          ].map((item, index) => (
            <div
              key={index}
              style={{
                border: `1px solid ${style.border}`,
                borderRadius: Math.max(14, style.radius - 8),
                background: index === 1 ? style.panelSoft : 'rgba(255,255,255,0.06)',
                padding: vertical ? '20px 24px' : '28px 30px',
                minHeight: vertical ? 132 : 260,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <SmartText
                stylePreset={stylePreset}
                variant={index === 1 ? 'accent' : 'muted'}
                maxChars={28}
                maxLines={1}
                baseSize={vertical ? 24 : 28}
                minSize={22}
              >
                {item.label}
              </SmartText>
              <div style={{ marginTop: 20 }}>
                <SmartText
                  stylePreset={stylePreset}
                  variant="title"
                  maxChars={56}
                  maxLines={vertical ? 2 : 3}
                  baseSize={vertical ? 40 : 50}
                  minSize={34}
                >
                  {item.content}
                </SmartText>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </InsertFrame>
  );
};
