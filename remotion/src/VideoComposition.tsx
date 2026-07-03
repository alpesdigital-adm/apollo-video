import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  OffthreadVideo,
  interpolate,
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
import { AssetCard } from './scenes/AssetCard';
import {
  LayoutSegmentRenderer,
  findActiveLayoutSegment,
} from './components/LayoutSegmentLayer';
import { FlashTransition } from './components/FlashTransition';

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
    case 'asset-card':
      return <AssetCard {...sceneProps} />;
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
  punchIns,
  audio,
}) => {
  const config = useVideoConfig();
  const frame = useCurrentFrame();

  // Jump-cut punch-in: alternating scale on the base video between silence cuts.
  // Only applied on the plain base-video layer (below) — an active layout segment
  // renders its own base video with its own zoom/effect, which takes precedence.
  const activePunchIn = (punchIns ?? []).find(
    (p) => frame >= p.fromFrame && frame < p.toFrame
  );
  const punchScale = activePunchIn ? activePunchIn.scale : 1;

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
  const isSplitImageActiveAt = (f: number): boolean =>
    splitTrackStart !== null && splitTrackEnd !== null && f >= splitTrackStart && f < splitTrackEnd;
  const isSplitImageActive = isSplitImageActiveAt(frame);
  const activeSplitLayout = isSplitImageActive ? activeSplitImage?.props?.layout : undefined;
  const isTopImageCompact = activeSplitLayout === 'top-image-compact';
  const splitVideoObjectPosition =
    typeof activeSplitImage?.props?.videoObjectPosition === 'string'
      ? activeSplitImage.props.videoObjectPosition
      : isTopImageCompact
        ? 'center 32%'
        : 'center 25%';

  // HookTitle visibility: EXCLUSIVITY-OF-HEADLINE rule + COMMITTED ENTRANCE rule.
  //
  // Exclusivity (unchanged in spirit): two headlines on screen at once (the
  // persistent top manchete + a typographic scene's own big text) is noise, so
  // the manchete hides while a HEADLINE scene owns the frame — any scene that
  // already plots large text on the canvas: FullScreen (any variant), CTA, Card,
  // SplitVertical, Number, Flow, Message, StickFigures, or a tweet-card layout
  // segment (a big text card). It stays visible — on top, legible — over
  // media/footage: talking-head base video, ImageInsert (all layouts, incl. the
  // split-image track), AssetCard, and the split-50 / blur-bg layout segments.
  //
  // Committed entrance: the manchete used to spring in at frame 0 regardless of
  // what was on screen, so when a title-card opened the video (e.g. a torn-paper
  // scene starting a few frames in) it flashed for a fraction of a second and
  // then vanished — a blink, not a decision. Instead we precompute the headline
  // occupancy timeline once (not per frame) and derive the FREE WINDOWS (its
  // complement). Only free windows with real runway (MIN_RUNWAY_SECONDS) are
  // "qualified" — the manchete's entranceFrame is the start of the first
  // qualified window, and it is only ever visible inside a qualified window.
  // Sub-MIN_OCCUPATION_SECONDS headline blips are dropped before computing free
  // windows, so a very short typographic flash doesn't chop up an otherwise long
  // runway or trigger a hide/show cycle — the manchete rides through it.
  const HEADLINE_SCENE_TYPES = new Set([
    'fullscreen',
    'cta',
    'card',
    'split-vertical',
    'number',
    'flow',
    'message',
    'stick-figures',
  ]);

  // A free window shorter than this isn't worth a debut: the manchete would
  // have to blink in and out again almost immediately, which is the exact bug
  // being fixed here.
  const MIN_RUNWAY_SECONDS = 2.5;
  // A headline occupation shorter than this is a blip, not a real takeover of
  // the frame — the manchete crosses through it without hiding.
  const MIN_OCCUPATION_SECONDS = 0.5;

  const { entranceFrame, qualifiedWindows } = useMemo(() => {
    const minOccupationFrames = Math.round(MIN_OCCUPATION_SECONDS * config.fps);
    const minRunwayFrames = Math.round(MIN_RUNWAY_SECONDS * config.fps);

    // 1) Raw intervals where a HEADLINE scene or tweet-card segment owns the
    // frame — same membership criteria as the old per-frame check, but built
    // once as [from, to) ranges instead of scanned on every frame.
    const raw: Array<{ from: number; to: number }> = [];
    scenes.forEach((scene) => {
      if (isSplitImageScene(scene) || generatedSegment(scene)) return;
      if (!HEADLINE_SCENE_TYPES.has(scene.type)) return;
      const startFrame = scene.fromFrame ?? Math.round(scene.from * config.fps);
      const endFrame = scene.toFrame ?? Math.round(scene.to * config.fps);
      if (endFrame > startFrame) raw.push({ from: startFrame, to: endFrame });
    });
    (layoutSegments ?? []).forEach((seg) => {
      if (seg.layout === 'tweet-card' && seg.toFrame > seg.fromFrame) {
        raw.push({ from: seg.fromFrame, to: seg.toFrame });
      }
    });
    raw.sort((a, b) => a.from - b.from);

    const merged: Array<{ from: number; to: number }> = [];
    raw.forEach((interval) => {
      const last = merged[merged.length - 1];
      if (last && interval.from <= last.to) {
        last.to = Math.max(last.to, interval.to);
      } else {
        merged.push({ from: interval.from, to: interval.to });
      }
    });

    // 2) Drop blips shorter than MIN_OCCUPATION_SECONDS — they don't count as
    // "occupied" for window purposes, so they get absorbed into free space.
    const significant = merged.filter((iv) => iv.to - iv.from >= minOccupationFrames);

    // 3) Free windows = complement of the significant occupied intervals
    // across the whole timeline.
    const free: Array<{ from: number; to: number }> = [];
    let cursor = 0;
    significant.forEach((iv) => {
      if (iv.from > cursor) free.push({ from: cursor, to: iv.from });
      cursor = Math.max(cursor, iv.to);
    });
    if (cursor < config.durationInFrames) {
      free.push({ from: cursor, to: config.durationInFrames });
    }

    // 4) Only windows with real runway qualify — this is where the manchete is
    // allowed to exist at all.
    const qualified = free.filter((w) => w.to - w.from >= minRunwayFrames);

    return {
      entranceFrame: qualified.length > 0 ? qualified[0].from : Infinity,
      qualifiedWindows: qualified,
    };
  }, [scenes, layoutSegments, config.fps, config.durationInFrames]);

  const isQualifiedFreeAt = (f: number): boolean =>
    qualifiedWindows.some((w) => f >= w.from && f < w.to);

  const HOOK_FADE_FRAMES = 6;
  let hookVisibility = 0;
  if (frame >= entranceFrame) {
    if (isQualifiedFreeAt(frame)) {
      let framesSinceClear = HOOK_FADE_FRAMES;
      for (let i = 1; i <= HOOK_FADE_FRAMES; i += 1) {
        if (!isQualifiedFreeAt(frame - i)) {
          framesSinceClear = i - 1;
          break;
        }
      }
      hookVisibility = interpolate(framesSinceClear, [0, HOOK_FADE_FRAMES], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    } else {
      let framesSinceObstructed = 0;
      while (
        framesSinceObstructed < HOOK_FADE_FRAMES &&
        !isQualifiedFreeAt(frame - framesSinceObstructed - 1)
      ) {
        framesSinceObstructed += 1;
      }
      hookVisibility = interpolate(framesSinceObstructed, [0, HOOK_FADE_FRAMES], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    }
  }

  // Background music: fade in over the first 0.5s and fade out over the
  // last 1.5s of the whole timeline. Absent when no `audio.music` was
  // resolved (empty public/audio/music = silence, not an error).
  const musicVolumeAt = (frame: number): number => {
    if (!audio?.music) return 0;
    const baseVolume = audio.music.volume;
    const fadeInFrames = Math.round(config.fps * 0.5);
    const fadeOutFrames = Math.round(config.fps * 1.5);
    const fadeInVolume = interpolate(frame, [0, fadeInFrames], [0, baseVolume], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    const fadeOutStart = Math.max(0, config.durationInFrames - fadeOutFrames);
    const fadeOutVolume = interpolate(
      frame,
      [fadeOutStart, config.durationInFrames],
      [baseVolume, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    return Math.min(fadeInVolume, fadeOutVolume);
  };

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
              transform: punchScale !== 1 ? `scale(${punchScale})` : undefined,
              transformOrigin: 'center 35%',
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

      {/* Flash transitions — white-hot burst centered on a scene's entrance */}
      {scenes.map((scene, index) =>
        scene.props?.transitionIn === 'flash' ? (
          <FlashTransition
            key={`flash-${index}`}
            startFrame={scene.fromFrame ?? Math.round(scene.from * config.fps)}
          />
        ) : null
      )}

      {/* SFX Layer — one Audio per event, gated by the segment it announces */}
      {audio?.events?.map((event, index) => (
        <Sequence key={`sfx-${index}-${event.kind}`} from={event.fromFrame}>
          <Audio src={event.src} volume={event.volume} />
        </Sequence>
      ))}

      {/* Background music track — looped, fades in/out at the timeline edges */}
      {audio?.music && <Audio src={audio.music.src} loop volume={musicVolumeAt} />}

      {/* Subtitle Layer */}
      <SubtitleOverlay
        subtitles={subtitles}
        format={format}
        palette={palette}
        layoutSegments={layoutSegments}
        subtitleStyle={subtitleStyle}
      />

      {/* Persistent hook headline (top) — renders nothing when unset; hides
          with a short fade over full-canvas scenes/overlays (see hookVisibility) */}
      <HookTitle
        text={hookTitle}
        format={format}
        visibility={hookVisibility}
        entranceFrame={entranceFrame}
      />
    </AbsoluteFill>
  );
};
