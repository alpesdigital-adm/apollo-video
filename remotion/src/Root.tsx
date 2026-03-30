import React from 'react';
import { Composition } from 'remotion';
import { VideoComposition } from './VideoComposition';
import {
  VERTICAL_WIDTH,
  VERTICAL_HEIGHT,
  HORIZONTAL_WIDTH,
  HORIZONTAL_HEIGHT,
  FPS,
} from './lib/constants';
import { CompositionProps } from './lib/types';

const defaultProps: CompositionProps = {
  scenes: [],
  subtitles: [],
  videoSrc: '',
  format: '9:16',
  palette: {
    primary: '#FF6B6B',
    secondary: '#4ECDC4',
    accent: '#FFB800',
    text: '#FFFFFF',
    background: '#000000',
  },
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="vertical"
        component={VideoComposition}
        durationInFrames={FPS * 60}
        fps={FPS}
        width={VERTICAL_WIDTH}
        height={VERTICAL_HEIGHT}
        defaultProps={{
          ...defaultProps,
          format: '9:16',
        }}
        schema={{
          scenes: { type: 'object' as const },
          subtitles: { type: 'object' as const },
          videoSrc: { type: 'string' as const },
          format: { type: 'enum' as const, options: ['9:16', '16:9'] },
          palette: { type: 'object' as const },
        }}
      />
      <Composition
        id="horizontal"
        component={VideoComposition}
        durationInFrames={FPS * 60}
        fps={FPS}
        width={HORIZONTAL_WIDTH}
        height={HORIZONTAL_HEIGHT}
        defaultProps={{
          ...defaultProps,
          format: '16:9',
        }}
        schema={{
          scenes: { type: 'object' as const },
          subtitles: { type: 'object' as const },
          videoSrc: { type: 'string' as const },
          format: { type: 'enum' as const, options: ['9:16', '16:9'] },
          palette: { type: 'object' as const },
        }}
      />
    </>
  );
};
