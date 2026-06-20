import React from 'react';
import { AccentRule, InsertFrame, Kicker, Panel, SmartText } from '../components/InsertPrimitives';

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
  emoji,
  format,
  stylePreset,
  durationInFrames,
}) => {
  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      placement="bottom"
      scrim
    >
      <Panel stylePreset={stylePreset} align="center" maxWidth={format === '9:16' ? 880 : 1120}>
        <Kicker stylePreset={stylePreset}>Proxima acao</Kicker>
        <SmartText
          stylePreset={stylePreset}
          variant="title"
          align="center"
          maxChars={76}
          maxLines={3}
          baseSize={format === '9:16' ? 62 : 74}
          minSize={40}
        >
          {text}
        </SmartText>
        {(highlightWord || emoji) && (
          <>
            <AccentRule stylePreset={stylePreset} />
            <SmartText
              stylePreset={stylePreset}
              variant="accent"
              align="center"
              maxChars={54}
              maxLines={2}
              baseSize={42}
              minSize={30}
            >
              {[highlightWord, emoji].filter(Boolean).join(' ')}
            </SmartText>
          </>
        )}
      </Panel>
    </InsertFrame>
  );
};
