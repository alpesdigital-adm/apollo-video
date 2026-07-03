import React from 'react';
import { InsertFrame, KineticText, Marker } from '../components/InsertPrimitives';

interface CardProps {
  number: number;
  icon?: string;
  title: string;
  description?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
}

export const Card: React.FC<CardProps> = ({
  number,
  icon,
  title,
  description,
  format,
  stylePreset,
  durationInFrames,
}) => {
  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="stage"
      align="center"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: format === '9:16' ? 30 : 36,
        }}
      >
        <div style={{ flexShrink: 0 }}>
          <Marker stylePreset={stylePreset} size={format === '9:16' ? 150 : 140}>
            {icon || number || '—'}
          </Marker>
        </div>
        <div style={{ textAlign: 'left', maxWidth: format === '9:16' ? 620 : 760 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="title"
            align="left"
            maxChars={44}
            maxLines={2}
            baseSize={format === '9:16' ? 70 : 74}
            minSize={44}
          >
            {title}
          </KineticText>
          {description && (
            <div style={{ marginTop: 14 }}>
              <KineticText
                stylePreset={stylePreset}
                variant="muted"
                align="left"
                maxChars={80}
                maxLines={3}
                baseSize={format === '9:16' ? 38 : 40}
                minSize={34}
                startDelay={5}
              >
                {description}
              </KineticText>
            </div>
          )}
        </div>
      </div>
    </InsertFrame>
  );
};
