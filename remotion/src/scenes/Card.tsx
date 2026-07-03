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
      zone="top"
      align="left"
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 22 }}>
        <div style={{ paddingTop: 6 }}>
          <Marker stylePreset={stylePreset} size={format === '9:16' ? 58 : 66}>
            {icon || number || '—'}
          </Marker>
        </div>
        <div style={{ flex: 1 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="title"
            align="left"
            maxChars={56}
            maxLines={2}
            baseSize={format === '9:16' ? 62 : 68}
            minSize={40}
          >
            {title}
          </KineticText>
          {description && (
            <div style={{ marginTop: 16 }}>
              <KineticText
                stylePreset={stylePreset}
                variant="muted"
                align="left"
                maxChars={88}
                maxLines={3}
                baseSize={36}
                minSize={28}
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
