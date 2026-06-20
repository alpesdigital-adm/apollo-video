import React from 'react';
import { InsertFrame, Kicker, Panel, SmartText } from '../components/InsertPrimitives';

interface MessageProps {
  senderName: string;
  messageText: string;
  isOwn?: boolean;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const Message: React.FC<MessageProps> = ({
  senderName,
  messageText,
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
      <Panel stylePreset={stylePreset} maxWidth={format === '9:16' ? 840 : 1000}>
        <Kicker stylePreset={stylePreset}>{senderName || 'Mensagem'}</Kicker>
        <SmartText
          stylePreset={stylePreset}
          variant="title"
          maxChars={82}
          maxLines={3}
          baseSize={format === '9:16' ? 48 : 58}
          minSize={32}
        >
          {messageText}
        </SmartText>
      </Panel>
    </InsertFrame>
  );
};
