import React from 'react';
import { AccentRule, InsertFrame, Kicker, Panel, SmartText } from '../components/InsertPrimitives';

interface FullScreenProps {
  title: string;
  subtitle?: string;
  text?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const FullScreen: React.FC<FullScreenProps> = ({
  title,
  subtitle,
  text,
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
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} align="center" maxWidth={format === '9:16' ? 880 : 1120}>
        <Kicker stylePreset={stylePreset}>Ponto-chave</Kicker>
        <SmartText
          stylePreset={stylePreset}
          variant="title"
          align="center"
          maxChars={72}
          maxLines={3}
          baseSize={format === '9:16' ? 74 : 82}
          minSize={44}
        >
          {mainText}
        </SmartText>
        {subtitle && (
          <>
            <AccentRule stylePreset={stylePreset} />
            <SmartText
              stylePreset={stylePreset}
              variant="muted"
              align="center"
              maxChars={84}
              maxLines={2}
              baseSize={38}
              minSize={30}
            >
              {subtitle}
            </SmartText>
          </>
        )}
      </Panel>
    </InsertFrame>
  );
};
