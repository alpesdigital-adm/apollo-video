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
import { getGrade, getGradeOverlayLayers, composeFilter } from './lib/grade';
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
  gradePreset,
  coldOpen,
}) => {
  const config = useVideoConfig();
  const frame = useCurrentFrame();
  const grade = getGrade(gradePreset);

  // COLD OPEN (Fase 3): `len` frames of teaser prepended at [0, len). All other
  // layers (scenes/subtitles/segments/punchIns) already arrive shifted by `len`
  // via the props resolvers; here we only (a) render the teaser + its audio, and
  // (b) offset the CONTINUOUS narrator footage source so timeline frame `len`
  // maps to source frame 0. `bgOffset` wraps the normal background in a Sequence
  // that resets the video source; `localizeSegment` rebases the active segment's
  // frames into that Sequence's local coordinates so its animations stay correct.
  const coLen = coldOpen && coldOpen.len > 0 ? coldOpen.len : 0;
  const inTeaser = coLen > 0 && frame < coLen;

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

  const { entranceFrame, qualifiedWindows, sceneIntervals, tweetIntervals } = useMemo(() => {
    const minOccupationFrames = Math.round(MIN_OCCUPATION_SECONDS * config.fps);
    const minRunwayFrames = Math.round(MIN_RUNWAY_SECONDS * config.fps);

    // 1) Raw intervals where a HEADLINE scene or tweet-card segment owns the
    // frame — same membership criteria as the old per-frame check, but built
    // once as [from, to) ranges instead of scanned on every frame.
    const mergeIntervals = (
      raw: Array<{ from: number; to: number }>
    ): Array<{ from: number; to: number }> => {
      const sorted = [...raw].sort((a, b) => a.from - b.from);
      const out: Array<{ from: number; to: number }> = [];
      sorted.forEach((interval) => {
        const last = out[out.length - 1];
        if (last && interval.from <= last.to) {
          last.to = Math.max(last.to, interval.to);
        } else {
          out.push({ from: interval.from, to: interval.to });
        }
      });
      return out;
    };

    const sceneRaw: Array<{ from: number; to: number }> = [];
    scenes.forEach((scene) => {
      if (isSplitImageScene(scene) || generatedSegment(scene)) return;
      if (!HEADLINE_SCENE_TYPES.has(scene.type)) return;
      const startFrame = scene.fromFrame ?? Math.round(scene.from * config.fps);
      const endFrame = scene.toFrame ?? Math.round(scene.to * config.fps);
      if (endFrame > startFrame) sceneRaw.push({ from: startFrame, to: endFrame });
    });
    const tweetRaw: Array<{ from: number; to: number }> = [];
    (layoutSegments ?? []).forEach((seg) => {
      if (seg.layout === 'tweet-card' && seg.toFrame > seg.fromFrame) {
        tweetRaw.push({ from: seg.fromFrame, to: seg.toFrame });
      }
    });

    const sceneMerged = mergeIntervals(sceneRaw);
    const tweetMerged = mergeIntervals(tweetRaw);
    // União (cenas + tweet) governa a exclusividade da manchete, como antes.
    // COLD OPEN: o intervalo [0, len) do teaser conta como OCUPADO — a manchete
    // nunca aparece durante a abertura (mas isso NÃO desloca a legenda: só entra
    // no cálculo da janela livre, não em sceneIntervals/tweetIntervals).
    const coldOpenRaw: Array<{ from: number; to: number }> =
      coLen > 0 ? [{ from: 0, to: coLen }] : [];
    const merged = mergeIntervals([...sceneRaw, ...tweetRaw, ...coldOpenRaw]);

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
      // Cenas tipográficas de palco → a legenda DESLOCA para o topo.
      sceneIntervals: sceneMerged,
      // Tweet-card é camada de LEITURA (a citação está no card) → a legenda
      // ESCONDE, nunca desloca para cima do header do card.
      tweetIntervals: tweetMerged,
    };
  }, [scenes, layoutSegments, config.fps, config.durationInFrames, coLen]);

  const isQualifiedFreeAt = (f: number): boolean =>
    qualifiedWindows.some((w) => f >= w.from && f < w.to);

  // Subtitle displacement: while a stage-typographic scene owns the frame (same
  // occupancy that hides the manchete), the karaoke subtitle rides at the TOP of
  // the head instead of the bottom, so it never embola with the centered
  // statement. Ramp both directions over SUB_FADE_FRAMES for a positional
  // crossfade (fade-out bottom / fade-in top), matching the manchete's ease.
  const isStageActiveAt = (f: number): boolean =>
    sceneIntervals.some((iv) => f >= iv.from && f < iv.to);
  const isTweetActiveAt = (f: number): boolean =>
    tweetIntervals.some((iv) => f >= iv.from && f < iv.to);

  const SUB_FADE_FRAMES = 8;
  // Rampa 0→1 quando isActiveAt liga, 1→0 quando desliga (crossfade suave).
  const rampFor = (isActiveAt: (f: number) => boolean): number => {
    if (isActiveAt(frame)) {
      let framesSinceClear = SUB_FADE_FRAMES;
      for (let i = 1; i <= SUB_FADE_FRAMES; i += 1) {
        if (!isActiveAt(frame - i)) {
          framesSinceClear = i - 1;
          break;
        }
      }
      return interpolate(framesSinceClear, [0, SUB_FADE_FRAMES], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    }
    // Conta quantos frames consecutivos IMEDIATAMENTE anteriores estavam
    // ocupados: acabou de liberar → contagem alta → fator ainda alto (desce
    // suave); liberado há tempo → contagem 0 → fator 0. A versão anterior
    // mapeava invertido ([1,0]) e travava o fator em 1 PARA SEMPRE ~8 frames
    // após qualquer ocupação — legendas sumiam do 1:30 em diante (bug real).
    let priorObstructed = 0;
    while (
      priorObstructed < SUB_FADE_FRAMES &&
      isActiveAt(frame - priorObstructed - 1)
    ) {
      priorObstructed += 1;
    }
    return interpolate(priorObstructed, [0, SUB_FADE_FRAMES], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  };

  const subtitleTopFactor = rampFor(isStageActiveAt);
  const subtitleHideFactor = rampFor(isTweetActiveAt);

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
      {/* SINGLE narrator AUDIO source for the WHOLE timeline. This is the ONLY
          audible element carrying the narrator's voice — every VISUAL video of
          the narrator (base layer, split-50, blur-bg, tweet-card, ImageInsert,
          AssetCard) is `muted`, so no frame ever has two audible narrator
          tracks (fixes the overlapping/echo audio). Rendered invisibly (1px,
          opacity 0) but always mounted, so its audio is extracted continuously
          and stays perfectly aligned with frame 0 like the old base layer did. */}
      {videoSrc && (
        coldOpen ? (
          // COLD OPEN: the single audible narrator source becomes TWO sequences —
          // [0, len) playing the source from `fromFrame` (the teaser's audio) and
          // [len, ∞) playing from source 0 (the normal flow). Never two audible at
          // the same frame; hard cut ("corte seco") on the seam.
          <>
            <Sequence durationInFrames={coLen}>
              <OffthreadVideo
                src={videoSrc}
                startFrom={coldOpen.fromFrame}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 1,
                  height: 1,
                  opacity: 0,
                  pointerEvents: 'none',
                }}
              />
            </Sequence>
            <Sequence from={coLen}>
              <OffthreadVideo
                src={videoSrc}
                startFrom={0}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 1,
                  height: 1,
                  opacity: 0,
                  pointerEvents: 'none',
                }}
              />
            </Sequence>
          </>
        ) : (
          <OffthreadVideo
            src={videoSrc}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: 'none',
            }}
          />
        )
      )}

      {/* COLD OPEN teaser — subtle: constant 1.04 punch-in, normal grade, NO B&W.
          Covers [0, len); the normal background below is a Sequence from={coLen}. */}
      {coldOpen && videoSrc && (
        <Sequence from={0} durationInFrames={coLen}>
          <AbsoluteFill style={{ backgroundColor: palette.background, overflow: 'hidden' }}>
            <OffthreadVideo
              src={videoSrc}
              muted
              startFrom={coldOpen.fromFrame}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center center',
                transform: 'scale(1.04)',
                transformOrigin: 'center 35%',
                filter: composeFilter(grade.filter),
                backgroundColor: palette.background,
              }}
            />
            {getGradeOverlayLayers(grade).map((layer) => (
              <div key={`teaser-${layer.key}`} style={layer.style} />
            ))}
          </AbsoluteFill>
        </Sequence>
      )}

      {/* Background Video (normal flow) — wrapped in a Sequence from={coLen} so the
          CONTINUOUS narrator source resets to frame 0 at `len` (no-op when coLen
          === 0). The active layout segment is rebased into the Sequence's local
          frame coordinates so its own animations (entrance/zoom) stay correct. */}
      <Sequence from={coLen}>
        {activeSegment ? (
          <LayoutSegmentRenderer
            segment={
              coLen > 0
                ? {
                    ...activeSegment,
                    fromFrame: activeSegment.fromFrame - coLen,
                    toFrame: activeSegment.toFrame - coLen,
                  }
                : activeSegment
            }
            videoSrc={videoSrc}
            palette={palette}
            format={format}
            creator={creator}
            gradePreset={gradePreset}
          />
        ) : (
          videoSrc && (
            <>
              <OffthreadVideo
                src={videoSrc}
                muted
                startFrom={0}
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
                  filter: composeFilter(grade.filter),
                  backgroundColor: palette.background,
                }}
              />
              {getGradeOverlayLayers(grade).map((layer) => (
                <div key={layer.key} style={layer.style} />
              ))}
            </>
          )
        )}
      </Sequence>

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

      {/* Subtitle Layer — displaces to the top of the head while a stage
          typographic scene owns the frame (subtitleTopFactor) */}
      <SubtitleOverlay
        subtitles={subtitles}
        format={format}
        palette={palette}
        layoutSegments={layoutSegments}
        subtitleStyle={subtitleStyle}
        topFactor={subtitleTopFactor}
        hideFactor={subtitleHideFactor}
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
