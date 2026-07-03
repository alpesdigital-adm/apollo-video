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
      zone="stage"
      align="center"
    >
      {/* Real vertical split: two halves side by side occupying the whole
          stage, thin central divider, each side centered. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'stretch',
          justifyContent: 'center',
          width: '100%',
          minHeight: vertical ? 360 : 300,
        }}
      >
        {items.map((item, index) => (
          <React.Fragment key={index}>
            {index === 1 && (
              <div
                style={{
                  width: 2,
                  alignSelf: 'stretch',
                  background: 'rgba(255,255,255,0.30)',
                  margin: '0 4px',
                  flexShrink: 0,
                }}
              />
            )}
            <div
              style={{
                width: '46%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 12px',
                boxSizing: 'border-box',
              }}
            >
              <div style={{ marginBottom: 14 }}>
                <KineticText
                  stylePreset={stylePreset}
                  variant="muted"
                  align="center"
                  maxChars={22}
                  maxLines={1}
                  baseSize={vertical ? 32 : 32}
                  minSize={26}
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
                align="center"
                maxChars={40}
                maxLines={3}
                baseSize={vertical ? 52 : 50}
                minSize={36}
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
