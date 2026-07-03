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
      zone="top"
      align="left"
      scrim={false}
    >
      <div
        style={{
          transform: `translateY(${(1 - pop) * 16}px) scale(${pop})`,
          transformOrigin: 'left top',
          maxWidth: format === '9:16' ? 720 : 900,
          background: 'rgba(255,255,255,0.14)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderRadius: 26,
          borderTopLeftRadius: 8,
          padding: '22px 28px',
          boxShadow: TEXT_SHADOW_SOFT,
        }}
      >
        {senderName && (
          <div
            style={{
              color: style.accent,
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: '-0.01em',
              marginBottom: 8,
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
          baseSize={format === '9:16' ? 42 : 48}
          minSize={30}
        >
          {messageText}
        </KineticText>
      </div>
    </InsertFrame>
  );
};
