import React from 'react';
import { InsertFrame, KineticText } from '../components/InsertPrimitives';

interface CTAProps {
  text: string;
  highlightWord?: string;
  emoji?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const CTA: React.FC<CTAProps> = ({
  text,
  highlightWord,
  format,
  stylePreset,
  durationInFrames,
}) => {
  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="top"
      align="left"
    >
      <KineticText
        stylePreset={stylePreset}
        highlight={highlightWord}
        variant="title"
        align="left"
        maxChars={64}
        maxLines={3}
        baseSize={format === '9:16' ? 78 : 84}
        minSize={46}
        pulse
      >
        {text}
      </KineticText>
    </InsertFrame>
  );
};
