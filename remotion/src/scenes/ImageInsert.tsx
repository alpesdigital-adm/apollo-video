import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { ColorPalette } from '../lib/types';

interface ImageInsertProps {
  imageSrc?: string;
  imagePath?: string;
  imageAlt?: string;
  // Pacote 3: animated b-roll clip (WaveSpeed i2v) or stock (Pexels) mp4.
  // When present, replaces the still. Gets the same gentle motion transform
  // as stills — 1%/8s doesn't fight the clip's own internal movement.
  videoSrc?: string;
  layout?: 'full' | 'split-bottom' | 'top-image-compact';
  visualRole?: 'evidence' | 'contrast' | 'process' | 'context' | 'decision';
  durationInFrames?: number;
  palette: ColorPalette;
  // Pacote 5: 5 deterministic micro-jumps over the first ~1.6s of the scene.
  stutter?: boolean;
}

export const ImageInsert: React.FC<ImageInsertProps> = ({
  imageSrc,
  imagePath,
  videoSrc,
  layout = 'full',
  durationInFrames = 90,
  palette,
  stutter,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const src = videoSrc || imageSrc || imagePath || '';
  const isVideo = Boolean(videoSrc);
  const motion = getImageMotion(src, frame, durationInFrames, fps);
  // When stutter is on, a deterministic micro-jump transform overrides the
  // gentle motion (for stills) and drives the otherwise-static video, then
  // settles to scale(1).
  const stutterTransform = stutter ? getStutterTransform(frame, fps) : null;
  // Vídeo também respira: o mesmo transform suave é aplicado ao container do
  // OffthreadVideo — 1%/8s não briga com o movimento interno do clipe.
  const mediaTransform =
    stutterTransform ?? `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`;
  const opacity = interpolate(
    frame,
    [0, 8, Math.max(9, durationInFrames - 8), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  if (!src) {
    return null;
  }

  if (layout === 'split-bottom' || layout === 'top-image-compact') {
    const isTopImageCompact = layout === 'top-image-compact';

    return (
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: isTopImageCompact ? 0 : undefined,
            bottom: isTopImageCompact ? undefined : 0,
            height: isTopImageCompact ? '30%' : '50%',
            overflow: 'hidden',
            backgroundColor: palette.background,
            opacity,
          }}
        >
          {isVideo ? (
            <OffthreadVideo
              src={src}
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: mediaTransform,
                filter: 'saturate(1.04) contrast(1.03)',
              }}
            />
          ) : (
            <Img
              src={src}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: mediaTransform,
                filter: 'saturate(1.04) contrast(1.03)',
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                isTopImageCompact
                  ? 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.02) 54%, rgba(0,0,0,0.2) 100%)'
                  : 'linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.02) 32%, rgba(0,0,0,0.22) 100%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: isTopImageCompact ? undefined : 0,
              bottom: isTopImageCompact ? 0 : undefined,
              height: 3,
              background:
                'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.68) 50%, transparent 100%)',
              opacity: 0.42,
            }}
          />
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        backgroundColor: palette.background,
        opacity,
      }}
    >
      {isVideo ? (
        <OffthreadVideo
          src={src}
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: mediaTransform,
            filter: 'saturate(1.03) contrast(1.02)',
          }}
        />
      ) : (
        <Img
          src={src}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: mediaTransform,
            filter: 'saturate(1.03) contrast(1.02)',
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.02) 42%, rgba(0,0,0,0.4) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};

interface ImageInsertTrackScene {
  fromFrame: number;
  toFrame: number;
  props: ImageInsertProps;
}

interface ImageInsertTrackProps {
  scenes: ImageInsertTrackScene[];
  palette: ColorPalette;
}

export const ImageInsertTrack: React.FC<ImageInsertTrackProps> = ({
  scenes,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const sortedScenes = [...scenes]
    .filter((scene) => Boolean(scene.props.imageSrc || scene.props.imagePath))
    .sort((a, b) => a.fromFrame - b.fromFrame);

  if (sortedScenes.length === 0) {
    return null;
  }

  const crossfadeFrames = Math.max(10, Math.round(config.fps * 0.42));
  // Uma imagem só é "segurada" até a próxima quando elas formam um bloco
  // consecutivo (gap curto). Imagens distantes respeitam a janela da própria
  // cena — segurar até a próxima cobria dezenas de segundos de outras cenas.
  const chainGapFrames = Math.round(config.fps * 1.5);

  const windows = sortedScenes.map((scene, index) => {
    const next = sortedScenes[index + 1];
    const chainedIntoNext = Boolean(
      next && next.fromFrame - scene.toFrame <= chainGapFrames
    );
    return {
      scene,
      start: scene.fromFrame,
      end: chainedIntoNext && next ? next.fromFrame : scene.toFrame,
      chainedIntoNext,
      chainedFromPrev: false,
    };
  });
  windows.forEach((window, index) => {
    if (index > 0) {
      window.chainedFromPrev = windows[index - 1].chainedIntoNext;
    }
  });

  const activeWindow = windows.find((w) => frame >= w.start && frame < w.end);
  if (!activeWindow) {
    return null;
  }

  const layout = activeWindow.scene.props.layout || 'top-image-compact';
  const isTopImageCompact = layout === 'top-image-compact';
  const isSplit = layout === 'split-bottom' || isTopImageCompact;

  if (!isSplit) {
    return null;
  }

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: isTopImageCompact ? 0 : undefined,
          bottom: isTopImageCompact ? undefined : 0,
          height: isTopImageCompact ? '30%' : '50%',
          overflow: 'hidden',
          backgroundColor: palette.background,
        }}
      >
        {windows.map((window) => {
          const scene = window.scene;
          const src = scene.props.imageSrc || scene.props.imagePath || '';
          const imageStart = window.start;
          const imageEnd = window.end;
          const opacity = getTrackImageOpacity({
            frame,
            imageStart,
            imageEnd,
            crossfadeFrames,
            chainedFromPrev: window.chainedFromPrev,
            chainedIntoNext: window.chainedIntoNext,
          });

          if (opacity <= 0.001) {
            return null;
          }

          const localFrame = Math.max(0, frame - imageStart);
          const localDuration = Math.max(1, imageEnd - imageStart);
          const motion = getImageMotion(src, localFrame, localDuration, config.fps);
          const stutterTransform = scene.props.stutter
            ? getStutterTransform(localFrame, config.fps)
            : null;

          return (
            <Img
              key={`${scene.fromFrame}-${src}`}
              src={src}
              alt=""
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity,
                transform:
                  stutterTransform ??
                  `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`,
                filter: 'saturate(1.06) contrast(1.04)',
              }}
            />
          );
        })}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              isTopImageCompact
                ? 'linear-gradient(180deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.02) 55%, rgba(0,0,0,0.18) 100%)'
                : 'linear-gradient(180deg, rgba(0,0,0,0.14) 0%, rgba(0,0,0,0.02) 35%, rgba(0,0,0,0.22) 100%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: isTopImageCompact ? undefined : 0,
            bottom: isTopImageCompact ? 0 : undefined,
            height: 2,
            background:
              'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.48) 50%, transparent 100%)',
            opacity: 0.34,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

function ramp(frame: number, start: number, end: number): number {
  if (end <= start) {
    return frame >= end ? 1 : 0;
  }

  return Math.max(0, Math.min(1, (frame - start) / (end - start)));
}

function getTrackImageOpacity({
  frame,
  imageStart,
  imageEnd,
  crossfadeFrames,
  chainedFromPrev,
  chainedIntoNext,
}: {
  frame: number;
  imageStart: number;
  imageEnd: number;
  crossfadeFrames: number;
  chainedFromPrev: boolean;
  chainedIntoNext: boolean;
}): number {
  // Encadeada com a anterior: crossfade centrado no limite (a anterior segura
  // até imageStart). Sem encadeamento: fade in contido na própria janela.
  const fadeInStart = chainedFromPrev ? imageStart - crossfadeFrames : imageStart;
  const fadeInEnd = imageStart + crossfadeFrames;
  // Encadeada com a próxima: crossfade centrado no limite. Sem encadeamento:
  // fade out termina NA janela — nunca vaza para cenas seguintes.
  const fadeOutStart = imageEnd - crossfadeFrames;
  const fadeOutEnd = chainedIntoNext ? imageEnd + crossfadeFrames : imageEnd;

  const fadeIn = imageStart <= 1 ? 1 : ramp(frame, fadeInStart, fadeInEnd);
  const fadeOut = 1 - ramp(frame, fadeOutStart, fadeOutEnd);

  return Math.max(0, Math.min(1, fadeIn * fadeOut));
}

// Pacote 5 — deterministic stutter cluster: 5 fixed micro-jumps (scale + offset)
// over the first ~1.6s, then a settled scale(1). No randomness; frame-driven.
const STUTTER_STEPS: Array<{ scale: number; x: number; y: number }> = [
  { scale: 1.0, x: 0, y: 0 },
  { scale: 1.14, x: 14, y: -14 },
  { scale: 1.04, x: -14, y: 14 },
  { scale: 1.18, x: 14, y: 14 },
  { scale: 1.08, x: -14, y: -14 },
];

function getStutterTransform(frame: number, fps: number): string {
  const stepFrames = Math.max(1, Math.round(fps / 3)); // ~10 frames @30fps
  const total = stepFrames * STUTTER_STEPS.length; // ~1.6s @30fps
  if (frame < 0 || frame >= total) {
    return 'translate3d(0px, 0px, 0) scale(1)';
  }
  const idx = Math.min(STUTTER_STEPS.length - 1, Math.floor(frame / stepFrames));
  const step = STUTTER_STEPS[idx];
  return `translate3d(${step.x}px, ${step.y}px, 0) scale(${step.scale})`;
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

// Regra do dono (2026-07): movimento em mídia (imagem OU vídeo) tem que ser
// SUAVE — algo como 1% de zoom a cada 5~10s, nunca pulos secos sem propósito.
// Taxa fixa aplicada em TODOS os pontos que chamam esta função (ImageInsert
// full/split/compact, o track, e os slots de LayoutSegmentLayer) — nenhuma
// variação por layout, só pela duração real da cena.
const MOTION_SCALE_RATE_PER_SEC = 0.0015; // 0.15%/s → ~1% em 7s
const MOTION_SCALE_TOTAL_MIN = 0.006; // piso 0.6% (cenas bem curtas)
const MOTION_SCALE_TOTAL_MAX = 0.02; // teto 2.0% (cenas longas)
const MOTION_PAN_RATE_PER_SEC = 1; // ≤1px/s de deslocamento total
const MOTION_PAN_TOTAL_MAX = 10; // px
// Overscan CONSTANTE (não anima) só para o pequeno pan nunca revelar a borda
// da mídia ajustada com object-fit: cover.
const MOTION_BASE_OVERSCAN = 1.015;

export function getImageMotion(
  src: string,
  frame: number,
  durationInFrames: number,
  fps: number
): { scale: number; x: number; y: number } {
  const durationInSeconds = Math.max(0.1, durationInFrames / Math.max(1, fps));
  const progress = Math.max(0, Math.min(1, frame / Math.max(1, durationInFrames)));
  const hash = hashString(src);
  const direction = hash % 2 === 0 ? 1 : -1;
  const verticalDirection = hash % 3 === 0 ? 1 : -1;
  const zoomIn = hash % 5 !== 0;

  const scaleTotal = Math.max(
    MOTION_SCALE_TOTAL_MIN,
    Math.min(MOTION_SCALE_TOTAL_MAX, durationInSeconds * MOTION_SCALE_RATE_PER_SEC)
  );
  const startScale = MOTION_BASE_OVERSCAN * (zoomIn ? 1 : 1 + scaleTotal);
  const endScale = MOTION_BASE_OVERSCAN * (zoomIn ? 1 + scaleTotal : 1);
  const scale = interpolate(
    progress,
    [0, 1],
    [startScale, endScale],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const panTotal = Math.min(MOTION_PAN_TOTAL_MAX, durationInSeconds * MOTION_PAN_RATE_PER_SEC);
  const panAmplitude = panTotal / 2;
  const x = interpolate(progress, [0, 1], [-panAmplitude * direction, panAmplitude * direction]);
  const y = interpolate(progress, [0, 1], [-panAmplitude * verticalDirection, panAmplitude * verticalDirection]);

  return { scale, x, y };
}
