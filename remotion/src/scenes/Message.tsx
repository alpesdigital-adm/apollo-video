import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface MessageProps {
  senderName: string;
  messageText: string;
  isOwn?: boolean;
  format: '9:16' | '16:9';
  palette: any;
}

export const Message: React.FC<MessageProps> = ({
  senderName,
  messageText,
  isOwn = false,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const translateX = spring({
    frame,
    fps: config.fps,
    from: isOwn ? 400 : -400,
    to: 0,
    duration: 40,
    damp: 0.8,
  });

  const opacity = interpolate(
    frame,
    [0, 15, config.durationInFrames - 20, config.durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: isOwn ? 'flex-end' : 'flex-start',
        paddingLeft: isOwn ? '0' : '40px',
        paddingRight: isOwn ? '40px' : '0',
        opacity,
      }}
    >
      <div
        style={{
          transform: `translateX(${translateX}px)`,
          maxWidth: '70%',
        }}
      >
        <p
          style={{
            fontSize: '28px',
            color: palette.text,
            margin: '0 0 12px 0',
            opacity: 0.7,
            textAlign: isOwn ? 'right' : 'left',
          }}
        >
          {senderName}
        </p>

        <div
          style={{
            backgroundColor: isOwn ? palette.accent : 'rgba(255, 255, 255, 0.1)',
            color: isOwn ? palette.background : palette.text,
            padding: '20px 24px',
            borderRadius: '20px',
            fontSize: '40px',
            lineHeight: '1.5',
            wordBreak: 'break-word',
            position: 'relative',
            marginBottom: '0',
          }}
        >
          {messageText}
          <div
            style={{
              position: 'absolute',
              bottom: '-10px',
              [isOwn ? 'right' : 'left']: '20px',
              width: '0',
              height: '0',
              borderLeft: isOwn ? '12px solid transparent' : '12px solid rgba(255, 255, 255, 0.1)',
              borderRight: isOwn ? `12px solid ${palette.accent}` : '12px solid transparent',
              borderTop: `12px solid ${isOwn ? palette.accent : 'rgba(255, 255, 255, 0.1)'}`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
