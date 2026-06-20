import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { ColorPalette } from '../lib/types';

interface ImageInsertProps {
  imageSrc?: string;
  imagePath?: string;
  imageAlt?: string;
  layout?: 'full' | 'split-bottom' | 'top-image-compact';
  visualRole?: 'evidence' | 'contrast' | 'process' | 'context' | 'decision';
  durationInFrames?: number;
  palette: ColorPalette;
}

export const ImageInsert: React.FC<ImageInsertProps> = ({
  imageSrc,
  imagePath,
  layout = 'full',
  durationInFrames = 90,
  palette,
}) => {
  const frame = useCurrentFrame();
  const src = imageSrc || imagePath || '';
  const motion = getImageMotion(src, layout, frame, durationInFrames);
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
          <Img
            src={src}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`,
              filter: 'saturate(1.04) contrast(1.03)',
            }}
          />
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
      <Img
        src={src}
        alt=""
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`,
          filter: 'saturate(1.03) contrast(1.02)',
        }}
      />
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

  const groupStart = sortedScenes[0].fromFrame;
  const groupEnd = Math.max(...sortedScenes.map((scene) => scene.toFrame));
  if (frame < groupStart || frame >= groupEnd) {
    return null;
  }

  const activeScene =
    [...sortedScenes].reverse().find((scene) => frame >= scene.fromFrame) ||
    sortedScenes[0];
  const layout = activeScene.props.layout || 'top-image-compact';
  const isTopImageCompact = layout === 'top-image-compact';
  const isSplit = layout === 'split-bottom' || isTopImageCompact;

  if (!isSplit) {
    return null;
  }

  const crossfadeFrames = Math.max(10, Math.round(config.fps * 0.42));

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
        {sortedScenes.map((scene, index) => {
          const src = scene.props.imageSrc || scene.props.imagePath || '';
          const nextScene = sortedScenes[index + 1];
          const imageStart = scene.fromFrame;
          const imageEnd = nextScene ? nextScene.fromFrame : groupEnd;
          const isFirst = index === 0;
          const isLast = index === sortedScenes.length - 1;
          const opacity = getTrackImageOpacity({
            frame,
            imageStart,
            imageEnd,
            groupStart,
            groupEnd,
            crossfadeFrames,
            isFirst,
            isLast,
          });

          if (opacity <= 0.001) {
            return null;
          }

          const localFrame = Math.max(0, frame - imageStart);
          const localDuration = Math.max(1, imageEnd - imageStart);
          const motion = getImageMotion(src, layout, localFrame, localDuration);

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
                transform: `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`,
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
  groupStart,
  groupEnd,
  crossfadeFrames,
  isFirst,
  isLast,
}: {
  frame: number;
  imageStart: number;
  imageEnd: number;
  groupStart: number;
  groupEnd: number;
  crossfadeFrames: number;
  isFirst: boolean;
  isLast: boolean;
}): number {
  const fadeInStart = isFirst ? groupStart : imageStart - crossfadeFrames;
  const fadeInEnd = isFirst ? groupStart + crossfadeFrames : imageStart + crossfadeFrames;
  const fadeOutStart = isLast ? groupEnd - crossfadeFrames : imageEnd - crossfadeFrames;
  const fadeOutEnd = isLast ? groupEnd : imageEnd + crossfadeFrames;

  const fadeIn = isFirst && groupStart <= 1 ? 1 : ramp(frame, fadeInStart, fadeInEnd);
  const fadeOut = 1 - ramp(frame, fadeOutStart, fadeOutEnd);

  return Math.max(0, Math.min(1, fadeIn * fadeOut));
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function getImageMotion(
  src: string,
  layout: 'full' | 'split-bottom' | 'top-image-compact',
  frame: number,
  durationInFrames: number
): { scale: number; x: number; y: number } {
  const progress = Math.max(0, Math.min(1, frame / Math.max(1, durationInFrames)));
  const hash = hashString(src);
  const direction = hash % 2 === 0 ? 1 : -1;
  const verticalDirection = hash % 3 === 0 ? 1 : -1;
  const zoomIn = hash % 5 !== 0;
  const isCompact = layout === 'top-image-compact';
  const isSplit = layout === 'split-bottom' || isCompact;
  const zoomRange = isCompact ? 0.024 : isSplit ? 0.032 : 0.045;
  const baseScale = isCompact ? 1.026 : isSplit ? 1.035 : 1.045;
  const startScale = zoomIn ? baseScale : baseScale + zoomRange;
  const endScale = zoomIn ? baseScale + zoomRange : baseScale;
  const scale = interpolate(
    progress,
    [0, 1],
    [startScale, endScale],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const panX = isCompact ? 8 : isSplit ? 12 : 18;
  const panY = isCompact ? 5 : isSplit ? 8 : 14;
  const x = interpolate(progress, [0, 1], [-panX * direction, panX * direction]);
  const y = interpolate(progress, [0, 1], [-panY * verticalDirection, panY * verticalDirection]);

  return { scale, x, y };
}
