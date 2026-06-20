import React from 'react';
import { Composition } from 'remotion';
import { VideoComposition } from './VideoComposition';
import {
  VERTICAL_WIDTH,
  VERTICAL_HEIGHT,
  HORIZONTAL_WIDTH,
  HORIZONTAL_HEIGHT,
  FPS,
  DEFAULT_DURATION_SECONDS,
} from './lib/constants';
import { CompositionProps } from './lib/types';

const defaultProps: CompositionProps = {
  scenes: [],
  subtitles: [],
  videoSrc: '',
  format: '9:16',
  stylePreset: 'creator-clean',
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
        durationInFrames={FPS * DEFAULT_DURATION_SECONDS}
        fps={FPS}
        width={VERTICAL_WIDTH}
        height={VERTICAL_HEIGHT}
        defaultProps={{
          ...defaultProps,
          format: '9:16',
        }}
      />
      <Composition
        id="horizontal"
        component={VideoComposition}
        durationInFrames={FPS * DEFAULT_DURATION_SECONDS}
        fps={FPS}
        width={HORIZONTAL_WIDTH}
        height={HORIZONTAL_HEIGHT}
        defaultProps={{
          ...defaultProps,
          format: '16:9',
        }}
      />
    </>
  );
};
