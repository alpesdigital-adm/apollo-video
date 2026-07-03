import React from 'react';
import { InsertFrame, KineticText } from '../components/InsertPrimitives';

interface FullScreenProps {
  title: string;
  subtitle?: string;
  text?: string;
  highlight?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const FullScreen: React.FC<FullScreenProps> = ({
  title,
  subtitle,
  text,
  highlight,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const mainText = title || text || 'Highlight';

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
        highlight={highlight}
        variant="title"
        align="left"
        maxChars={72}
        maxLines={3}
        baseSize={format === '9:16' ? 86 : 92}
        minSize={48}
      >
        {mainText}
      </KineticText>
      {subtitle && (
        <div style={{ marginTop: 22 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="muted"
            align="left"
            maxChars={84}
            maxLines={2}
            baseSize={38}
            minSize={30}
            startDelay={6}
          >
            {subtitle}
          </KineticText>
        </div>
      )}
    </InsertFrame>
  );
};
