import React from 'react';
import { AccentRule, InsertFrame, Kicker, Panel, SmartText } from '../components/InsertPrimitives';

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

export const StickFigures: React.FC<StickFiguresProps> = ({
  situation,
  caption,
  leftCaption,
  rightCaption,
  format,
  stylePreset,
  durationInFrames,
}) => {
  const primary = situation || leftCaption || 'Cenario';
  const secondary = caption || rightCaption || '';

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} maxWidth={format === '9:16' ? 860 : 1020}>
        <Kicker stylePreset={stylePreset}>Cenario</Kicker>
        <SmartText
          stylePreset={stylePreset}
          variant="title"
          maxChars={64}
          maxLines={2}
          baseSize={format === '9:16' ? 54 : 62}
          minSize={34}
        >
          {primary}
        </SmartText>
        {secondary && (
          <>
            <AccentRule stylePreset={stylePreset} />
            <SmartText
              stylePreset={stylePreset}
              variant="muted"
              maxChars={84}
              maxLines={2}
              baseSize={34}
              minSize={27}
            >
              {secondary}
            </SmartText>
          </>
        )}
      </Panel>
    </InsertFrame>
  );
};
