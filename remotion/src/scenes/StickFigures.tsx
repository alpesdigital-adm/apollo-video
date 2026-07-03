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
  const primary = situation || leftCaption || 'Cenario';
  const secondary = caption || rightCaption || '';

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="top"
      align="left"
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 26, marginBottom: 28 }}>
        <StickFigure color={style.text} size={format === '9:16' ? 70 : 78} />
        <StickFigure color={style.accent} size={format === '9:16' ? 70 : 78} />
      </div>
      <KineticText
        stylePreset={stylePreset}
        variant="title"
        align="left"
        maxChars={62}
        maxLines={2}
        baseSize={format === '9:16' ? 56 : 62}
        minSize={36}
      >
        {primary}
      </KineticText>
      {secondary && (
        <div style={{ marginTop: 16 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="muted"
            align="left"
            maxChars={84}
            maxLines={2}
            baseSize={34}
            minSize={27}
            startDelay={5}
          >
            {secondary}
          </KineticText>
        </div>
      )}
    </InsertFrame>
  );
};
