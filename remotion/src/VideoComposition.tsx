import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  useVideoConfig,
} from 'remotion';
import { CompositionProps, Scene } from './lib/types';
import { SubtitleOverlay } from './components/SubtitleOverlay';
import { FullScreen } from './scenes/FullScreen';
import { LowerThird } from './scenes/LowerThird';
import { Split } from './scenes/Split';
import { SplitVertical } from './scenes/SplitVertical';
import { Card } from './scenes/Card';
import { Message } from './scenes/Message';
import { Number as NumberScene } from './scenes/Number';
import { Flow } from './scenes/Flow';
import { CTA } from './scenes/CTA';
import { StickFigures } from './scenes/StickFigures';

interface SceneComponentProps {
  format: '9:16' | '16:9';
  palette: any;
  [key: string]: any;
}

const renderSceneComponent = (
  scene: Scene,
  format: '9:16' | '16:9',
  palette: any
): React.ReactNode => {
  const props: SceneComponentProps = {
    format,
    palette,
    ...scene.props,
  };

  switch (scene.type) {
    case 'fullscreen':
      return <FullScreen {...props} />;
    case 'lower-third':
      return <LowerThird {...props} />;
    case 'split':
      return <Split {...props} />;
    case 'split-vertical':
      return <SplitVertical {...props} />;
    case 'card':
      return <Card {...props} />;
    case 'message':
      return <Message {...props} />;
    case 'number':
      return <NumberScene {...props} />;
    case 'flow':
      return <Flow {...props} />;
    case 'cta':
      return <CTA {...props} />;
    case 'stick-figures':
      return <StickFigures {...props} />;
    default:
      return null;
  }
};

export const VideoComposition: React.FC<CompositionProps> = ({
  scenes,
  subtitles,
  videoSrc,
  format,
  palette,
}) => {
  const config = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      {/* Background Video */}
      {videoSrc && (
        <OffthreadVideo
          src={videoSrc}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}

      {/* Scene Layers */}
      {scenes.map((scene, index) => {
        const startFrame = Math.round(scene.from * config.fps);
        const duration = Math.round((scene.to - scene.from) * config.fps);

        return (
          <Sequence
            key={index}
            from={startFrame}
            durationInFrames={duration}
          >
            {renderSceneComponent(scene, format, palette)}
          </Sequence>
        );
      })}

      {/* Subtitle Layer */}
      <SubtitleOverlay
        subtitles={subtitles}
        format={format}
        palette={palette}
      />
    </AbsoluteFill>
  );
};
