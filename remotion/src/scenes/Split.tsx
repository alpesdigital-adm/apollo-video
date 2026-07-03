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
      zone="top"
      align="left"
    >
      {first && (
        <KineticText
          stylePreset={stylePreset}
          variant="muted"
          align="left"
          maxChars={64}
          maxLines={2}
          baseSize={format === '9:16' ? 38 : 42}
          minSize={30}
        >
          {first}
        </KineticText>
      )}
      {second && (
        <div style={{ marginTop: 18 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="title"
            align="left"
            maxChars={62}
            maxLines={2}
            baseSize={format === '9:16' ? 60 : 66}
            minSize={38}
            startDelay={6}
          >
            {second}
          </KineticText>
        </div>
      )}
    </InsertFrame>
  );
};
