import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { InsertFrame, KineticText, TEXT_SHADOW, getInsertStyle } from '../components/InsertPrimitives';

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
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const displayValue = `${prefix || ''}${value || ''}${suffix || ''}`.trim() || '1';

  const pop = spring({ frame, fps, from: 0.6, to: 1, durationInFrames: 22, config: { damping: 200 } });

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
          transform: `translateY(${(1 - pop) * 20}px) scale(${pop})`,
          transformOrigin: 'center',
          opacity: pop,
          color: style.accent,
          fontSize: format === '9:16' ? 300 : 240,
          fontWeight: 800,
          lineHeight: 0.9,
          letterSpacing: '-0.04em',
          textShadow: TEXT_SHADOW,
          textAlign: 'center',
        }}
      >
        {displayValue}
      </div>
      {label && (
        <div style={{ marginTop: 12 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="title"
            align="center"
            maxChars={60}
            maxLines={2}
            baseSize={format === '9:16' ? 56 : 60}
            minSize={38}
            startDelay={5}
          >
            {label}
          </KineticText>
        </div>
      )}
    </InsertFrame>
  );
};
