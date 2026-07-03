import React from 'react';
import { InsertFrame, KineticText } from '../components/InsertPrimitives';

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
  const vertical = format === '9:16';

  const items = [
    { label: leftLabel || 'Antes', content: leftContent, accent: false },
    { label: rightLabel || 'Depois', content: rightContent, accent: true },
  ];

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="top"
      align="left"
    >
      <div
        style={{
          display: 'flex',
          flexDirection: vertical ? 'column' : 'row',
          gap: vertical ? 26 : 40,
          width: '100%',
        }}
      >
        {items.map((item, index) => (
          <React.Fragment key={index}>
            {index === 1 && (
              <div
                style={{
                  background: 'rgba(255,255,255,0.28)',
                  ...(vertical
                    ? { height: 2, width: '52%', margin: '2px 0' }
                    : { width: 2, alignSelf: 'stretch' }),
                }}
              />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ marginBottom: 10 }}>
                <KineticText
                  stylePreset={stylePreset}
                  variant="muted"
                  align="left"
                  maxChars={22}
                  maxLines={1}
                  baseSize={vertical ? 28 : 30}
                  minSize={24}
                  highlight={item.accent ? item.label : undefined}
                  startDelay={index * 4}
                >
                  {item.label}
                </KineticText>
              </div>
              <KineticText
                stylePreset={stylePreset}
                highlight={item.accent ? item.content : undefined}
                variant="title"
                align="left"
                maxChars={54}
                maxLines={vertical ? 2 : 3}
                baseSize={vertical ? 48 : 52}
                minSize={34}
                startDelay={index * 4 + 3}
              >
                {item.content}
              </KineticText>
            </div>
          </React.Fragment>
        ))}
      </div>
    </InsertFrame>
  );
};
