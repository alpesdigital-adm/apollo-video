import React from 'react';
import { InsertFrame, KineticText, getInsertStyle } from '../components/InsertPrimitives';

interface StickFiguresProps {
  situation?: string;
  caption?: string;
  leftCaption?: string;
  rightCaption?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

const StickFigure: React.FC<{ color: string; size: number }> = ({ color, size }) => (
  <svg
    width={size}
    height={size * 1.6}
    viewBox="0 0 40 64"
    fill="none"
    stroke={color}
    strokeWidth={4}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ filter: 'drop-shadow(0 2px 10px rgba(0,0,0,0.85))' }}
  >
    <circle cx="20" cy="10" r="8" />
    <line x1="20" y1="18" x2="20" y2="42" />
    <line x1="20" y1="24" x2="8" y2="34" />
    <line x1="20" y1="24" x2="32" y2="34" />
    <line x1="20" y1="42" x2="9" y2="58" />
    <line x1="20" y1="42" x2="31" y2="58" />
  </svg>
);

export const StickFigures: React.FC<StickFiguresProps> = ({
  situation,
  caption,
  leftCaption,
  rightCaption,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const style = getInsertStyle(stylePreset);
  const leftText = leftCaption || situation || 'Cenario';
  const rightText = rightCaption || caption || '';
  const figSize = format === '9:16' ? 190 : 170;

  const columns = [
    { color: style.text, text: leftText, accent: false, delay: 0 },
    { color: style.accent, text: rightText, accent: true, delay: 5 },
  ].filter((c) => c.text);

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="stage"
      align="center"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: format === '9:16' ? 56 : 80,
          width: '100%',
        }}
      >
        {columns.map((col, index) => (
          <div
            key={index}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              width: '44%',
            }}
          >
            <StickFigure color={col.color} size={figSize} />
            <div style={{ marginTop: 20 }}>
              <KineticText
                stylePreset={stylePreset}
                highlight={col.accent ? col.text : undefined}
                variant="title"
                align="center"
                maxChars={48}
                maxLines={3}
                baseSize={format === '9:16' ? 40 : 42}
                minSize={30}
                startDelay={col.delay}
              >
                {col.text}
              </KineticText>
            </div>
          </div>
        ))}
      </div>
    </InsertFrame>
  );
};
