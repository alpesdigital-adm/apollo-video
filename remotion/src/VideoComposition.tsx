import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  OffthreadVideo,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { CompositionProps, CreatorProfile, Scene } from './lib/types';
import { SubtitleOverlay } from './components/SubtitleOverlay';
import { HookTitle } from './components/HookTitle';
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
import { ImageInsert, ImageInsertTrack } from './scenes/ImageInsert';
import {
  LayoutSegmentRenderer,
  findActiveLayoutSegment,
} from './components/LayoutSegmentLayer';

interface SceneComponentProps {
  format: '9:16' | '16:9';
  palette: any;
  [key: string]: any;
}

const renderSceneComponent = (
  scene: Scene,
  format: '9:16' | '16:9',
  palette: any,
  stylePreset?: string,
  durationInFrames?: number,
  creator?: CreatorProfile
): React.ReactNode => {
  const props: SceneComponentProps = {
    format,
    palette,
    stylePreset,
    durationInFrames,
    ...scene.props,
  };
  const sceneProps = props as any;

  switch (scene.type) {
    case 'fullscreen':
      return <FullScreen {...sceneProps} />;
    case 'lower-third':
      return <LowerThird {...sceneProps} />;
    case 'split':
      return <Split {...sceneProps} />;
    case 'split-vertical':
      return <SplitVertical {...sceneProps} />;
    case 'card':
      return <Card {...sceneProps} />;
    case 'message':
      return <Message {...sceneProps} />;
    case 'number':
      return <NumberScene {...sceneProps} />;
    case 'flow':
      return <Flow {...sceneProps} />;
    case 'cta':
      return <CTA {...sceneProps} creator={creator} />;
    case 'stick-figures':
      return <StickFigures {...sceneProps} />;
    case 'image-insert':
      return <ImageInsert {...sceneProps} />;
    default:
      return null;
  }
};

function hasImageAsset(scene: Scene): boolean {
  return Boolean(scene.props?.imageSrc || scene.props?.imagePath);
}

function isSplitImageScene(scene: Scene): boolean {
  const layout = scene.props?.layout;
  return (
    scene.type === 'image-insert' &&
    hasImageAsset(scene) &&
    (layout === 'split-bottom' || layout === 'top-image-compact')
  );
}

export const VideoComposition: React.FC<CompositionProps> = ({
  scenes,
  subtitles,
  videoSrc,
  format,
  palette,
  stylePreset,
  subtitleStyle,
  hookTitle,
  creator,
  layoutSegments,
}) => {
  const config = useVideoConfig();
  const frame = useCurrentFrame();

  // Segment layout track. A scene carrying `segmentLayout` produces a segment
  // over its window; the fromFrame equals the scene's startFrame, so we suppress
  // that scene's own overlay (the segment renderer takes over the visual) and
  // exclude it from the legacy split-image track to avoid duplicated media.
  const activeSegment = findActiveLayoutSegment(layoutSegments, frame);
  const segmentFromFrames = new Set(
    (layoutSegments ?? [])
      .filter((seg) => seg.layout !== 'fullscreen')
      .map((seg) => seg.fromFrame)
  );
  const generatedSegment = (scene: Scene): boolean => {
    const startFrame = scene.fromFrame ?? Math.round(scene.from * config.fps);
    return segmentFromFrames.has(startFrame);
  };

  const splitImageScenes = scenes
    .filter((scene) => isSplitImageScene(scene) && !generatedSegment(scene))
    .sort((a, b) => {
      const aStart = a.fromFrame ?? Math.round(a.from * config.fps);
      const bStart = b.fromFrame ?? Math.round(b.from * config.fps);
      return aStart - bStart;
    });
  const splitTrackStart = splitImageScenes[0]
    ? splitImageScenes[0].fromFrame ?? Math.round(splitImageScenes[0].from * config.fps)
    : null;
  const splitTrackEnd = splitImageScenes.length > 0
    ? Math.max(
        ...splitImageScenes.map((scene) => scene.toFrame ?? Math.round(scene.to * config.fps))
      )
    : null;
  const activeSplitImage = splitImageScenes.find((scene) => {
    const startFrame = scene.fromFrame ?? Math.round(scene.from * config.fps);
    const nextScene = splitImageScenes[splitImageScenes.indexOf(scene) + 1];
    const endFrame = nextScene
      ? nextScene.fromFrame ?? Math.round(nextScene.from * config.fps)
      : splitTrackEnd ?? scene.toFrame ?? Math.round(scene.to * config.fps);

    return (
      frame >= startFrame &&
      frame < endFrame
    );
  }) || splitImageScenes[0];
  const isSplitImageActive =
    splitTrackStart !== null &&
    splitTrackEnd !== null &&
    frame >= splitTrackStart &&
    frame < splitTrackEnd;
  const activeSplitLayout = isSplitImageActive ? activeSplitImage?.props?.layout : undefined;
  const isTopImageCompact = activeSplitLayout === 'top-image-compact';
  const splitVideoObjectPosition =
    typeof activeSplitImage?.props?.videoObjectPosition === 'string'
      ? activeSplitImage.props.videoObjectPosition
      : isTopImageCompact
        ? 'center 32%'
        : 'center 25%';

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      {/* Background Video — a layout segment takes over its own window */}
      {activeSegment ? (
        <LayoutSegmentRenderer
          segment={activeSegment}
          videoSrc={videoSrc}
          palette={palette}
          format={format}
          creator={creator}
        />
      ) : (
        videoSrc && (
          <OffthreadVideo
            src={videoSrc}
            style={{
              position: 'absolute',
              top: isTopImageCompact ? '30%' : 0,
              left: 0,
              width: '100%',
              height: isTopImageCompact ? '70%' : isSplitImageActive ? '50%' : '100%',
              objectFit: 'cover',
              objectPosition: isSplitImageActive ? splitVideoObjectPosition : 'center center',
              backgroundColor: palette.background,
            }}
          />
        )
      )}

      {/* Scene Layers */}
      {scenes.map((scene, index) => {
        if (isSplitImageScene(scene) || generatedSegment(scene)) {
          return null;
        }

        const startFrame = scene.fromFrame ?? Math.round(scene.from * config.fps);
        const endFrame = scene.toFrame ?? Math.round(scene.to * config.fps);
        const duration = Math.max(1, endFrame - startFrame);

        return (
          <Sequence
            key={index}
            from={startFrame}
            durationInFrames={duration}
          >
            {renderSceneComponent(scene, format, palette, stylePreset, duration, creator)}
          </Sequence>
        );
      })}

      <ImageInsertTrack
        scenes={splitImageScenes.map((scene) => ({
          fromFrame: scene.fromFrame ?? Math.round(scene.from * config.fps),
          toFrame: scene.toFrame ?? Math.round(scene.to * config.fps),
          props: scene.props as any,
        }))}
        palette={palette}
      />

      {/* Subtitle Layer */}
      <SubtitleOverlay
        subtitles={subtitles}
        format={format}
        palette={palette}
        layoutSegments={layoutSegments}
        subtitleStyle={subtitleStyle}
      />

      {/* Persistent hook headline (top) — renders nothing when unset */}
      <HookTitle text={hookTitle} format={format} />
    </AbsoluteFill>
  );
};
