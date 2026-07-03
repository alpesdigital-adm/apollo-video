import React from 'react';
import { InsertFrame, KineticText } from '../components/InsertPrimitives';

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
  const first = topText || title;
  const second = bottomText || content;

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="stage"
      align="center"
    >
      {first && (
        <KineticText
          stylePreset={stylePreset}
          variant="muted"
          align="center"
          maxChars={64}
          maxLines={2}
          baseSize={format === '9:16' ? 40 : 42}
          minSize={32}
        >
          {first}
        </KineticText>
      )}
      {second && (
        <div style={{ marginTop: 20 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="title"
            align="center"
            maxChars={62}
            maxLines={3}
            baseSize={format === '9:16' ? 84 : 74}
            minSize={50}
            startDelay={6}
          >
            {second}
          </KineticText>
        </div>
      )}
    </InsertFrame>
  );
};
