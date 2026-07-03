import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { InsertFrame, KineticText, TEXT_SHADOW_SOFT, getInsertStyle } from '../components/InsertPrimitives';

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
  const style = getInsertStyle(stylePreset);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, from: 0.9, to: 1, durationInFrames: 18, config: { damping: 200 } });

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="stage"
      align="center"
      scrim={false}
    >
      <div
        style={{
          transform: `translateY(${(1 - pop) * 16}px) scale(${pop})`,
          transformOrigin: 'center',
          width: format === '9:16' ? '72%' : '62%',
          background: 'rgba(255,255,255,0.15)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderRadius: 30,
          borderBottomRightRadius: 10,
          padding: format === '9:16' ? '30px 36px' : '26px 32px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
          textAlign: 'left',
        }}
      >
        {senderName && (
          <div
            style={{
              color: style.accent,
              fontSize: 32,
              fontWeight: 800,
              letterSpacing: '-0.01em',
              marginBottom: 10,
              textShadow: TEXT_SHADOW_SOFT,
            }}
          >
            {senderName}
          </div>
        )}
        <KineticText
          stylePreset={stylePreset}
          variant="title"
          align="left"
          maxChars={82}
          maxLines={3}
          baseSize={format === '9:16' ? 52 : 52}
          minSize={36}
        >
          {messageText}
        </KineticText>
      </div>
    </InsertFrame>
  );
};
