import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { CreatorProfile, LayoutSegment, ColorPalette } from '../lib/types';
import { getImageMotion } from '../scenes/ImageInsert';

/**
 * Find the segment active at `frame`. Segments never overlap (they derive from
 * non-overlapping scenes), so at most one is active. Fullscreen segments are
 * treated as "no segment" — the base video renders with its normal behavior.
 */
export function findActiveLayoutSegment(
  segments: LayoutSegment[] | undefined,
  frame: number
): LayoutSegment | null {
  if (!Array.isArray(segments)) {
    return null;
  }
  for (const seg of segments) {
    // A fullscreen segment only matters when it carries an effect (bw / zoom);
    // otherwise it is indistinguishable from the default base video layer.
    if (seg.layout === 'fullscreen' && !seg.effects?.zoom && !seg.effects?.bw) {
      continue;
    }
    if (frame >= seg.fromFrame && frame < seg.toFrame) {
      return seg;
    }
  }
  return null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Pacote 3: a segment's mediaSrc may be an animated/stock .mp4 instead of a still.
function isVideoSrc(src: string): boolean {
  return /\.mp4($|\?)/i.test(src);
}

// Base-video transform + filter derived from the segment effects (zoom / bw).
function useBaseVideoEffect(segment: LayoutSegment): {
  transform: string;
  filterParts: string[];
} {
  const frame = useCurrentFrame();
  const dur = Math.max(1, segment.toFrame - segment.fromFrame);
  const p = clamp01((frame - segment.fromFrame) / dur);

  let scale = 1;
  if (segment.effects?.zoom === 'in') {
    scale = interpolate(p, [0, 1], [1.0, 1.08], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  } else if (segment.effects?.zoom === 'out') {
    scale = interpolate(p, [0, 1], [1.08, 1.0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  const filterParts: string[] = [];
  if (segment.effects?.bw) {
    filterParts.push('grayscale(1)');
  }

  return { transform: `scale(${scale})`, filterParts };
}

// Same gentle motion regime as ImageInsert (1%/5~10s, no per-layout tuning),
// applied to whichever media slot the segment carries (split-50 top image or
// blur-bg centered card) — image or video alike.
function useSegmentMediaMotion(segment: LayoutSegment, mediaSrc: string): { transform: string } {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = Math.max(1, segment.toFrame - segment.fromFrame);
  const localFrame = Math.max(0, frame - segment.fromFrame);
  const motion = getImageMotion(mediaSrc, localFrame, dur, fps);
  return {
    transform: `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`,
  };
}

interface LayoutSegmentRendererProps {
  segment: LayoutSegment;
  videoSrc: string;
  palette: ColorPalette;
  format: '9:16' | '16:9';
  creator?: CreatorProfile;
}

/**
 * Renders the base video (and any accompanying media) for the active layout
 * segment. Replaces the normal fullscreen base-video layer for its window.
 */
export const LayoutSegmentRenderer: React.FC<LayoutSegmentRendererProps> = ({
  segment,
  videoSrc,
  palette,
  format,
  creator,
}) => {
  const { transform, filterParts } = useBaseVideoEffect(segment);
  const mediaSrc =
    typeof segment.props?.mediaSrc === 'string' ? (segment.props.mediaSrc as string) : '';
  const mediaMotion = useSegmentMediaMotion(segment, mediaSrc);
  const baseFilter = filterParts.length ? filterParts.join(' ') : undefined;

  if (segment.layout === 'fullscreen') {
    // Effect-only segment: base video full-canvas with zoom / grayscale applied.
    return (
      <AbsoluteFill style={{ backgroundColor: palette.background, overflow: 'hidden' }}>
        {videoSrc && (
          <OffthreadVideo
            src={videoSrc}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform,
              transformOrigin: 'center 35%',
              filter: baseFilter,
              backgroundColor: palette.background,
            }}
          />
        )}
      </AbsoluteFill>
    );
  }

  if (segment.layout === 'split-50') {
    return (
      <AbsoluteFill style={{ backgroundColor: palette.background }}>
        {/* Top half — media */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '50%',
            overflow: 'hidden',
            backgroundColor: palette.background,
          }}
        >
          {mediaSrc &&
            (isVideoSrc(mediaSrc) ? (
              <OffthreadVideo
                src={mediaSrc}
                muted
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  transform: mediaMotion.transform,
                  filter: 'saturate(1.05) contrast(1.03)',
                }}
              />
            ) : (
              <Img
                src={mediaSrc}
                alt=""
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  transform: mediaMotion.transform,
                  filter: 'saturate(1.05) contrast(1.03)',
                }}
              />
            ))}
        </div>

        {/* Bottom half — base video, framed on the face (center-top) */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            width: '100%',
            height: '50%',
            overflow: 'hidden',
            backgroundColor: palette.background,
          }}
        >
          {videoSrc && (
            <OffthreadVideo
              src={videoSrc}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center 25%',
                transform,
                transformOrigin: 'center 35%',
                filter: baseFilter,
              }}
            />
          )}
        </div>

        {/* Seam divider */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: 3,
            transform: 'translateY(-1.5px)',
            background:
              'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%)',
            opacity: 0.5,
          }}
        />
      </AbsoluteFill>
    );
  }

  if (segment.layout === 'blur-bg') {
    return (
      <AbsoluteFill style={{ backgroundColor: palette.background }}>
        {videoSrc && (
          <OffthreadVideo
            src={videoSrc}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform,
              transformOrigin: 'center 35%',
              filter: ['blur(40px)', 'brightness(0.55)', ...filterParts].join(' '),
            }}
          />
        )}
        {mediaSrc && (
          <AbsoluteFill
            style={{ alignItems: 'center', justifyContent: 'center' }}
          >
            {isVideoSrc(mediaSrc) ? (
              <OffthreadVideo
                src={mediaSrc}
                muted
                style={{
                  width: '78%',
                  maxHeight: '72%',
                  objectFit: 'cover',
                  borderRadius: 28,
                  transform: mediaMotion.transform,
                  boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.5)',
                }}
              />
            ) : (
              <Img
                src={mediaSrc}
                alt=""
                style={{
                  width: '78%',
                  maxHeight: '72%',
                  objectFit: 'cover',
                  borderRadius: 28,
                  transform: mediaMotion.transform,
                  boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.5)',
                }}
              />
            )}
          </AbsoluteFill>
        )}
      </AbsoluteFill>
    );
  }

  // tweet-card
  return (
    <TweetCard
      segment={segment}
      videoSrc={videoSrc}
      palette={palette}
      format={format}
      creator={creator}
      baseTransform={transform}
      baseFilterParts={filterParts}
    />
  );
};

interface TweetCardProps {
  segment: LayoutSegment;
  videoSrc: string;
  palette: ColorPalette;
  format: '9:16' | '16:9';
  creator?: CreatorProfile;
  baseTransform: string;
  baseFilterParts: string[];
}

const TweetCard: React.FC<TweetCardProps> = ({
  segment,
  videoSrc,
  palette,
  creator,
  baseTransform,
  baseFilterParts,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = typeof segment.props?.text === 'string' ? (segment.props.text as string) : '';

  const enter = spring({
    frame: Math.max(0, frame - segment.fromFrame),
    fps,
    config: { damping: 18, stiffness: 160, mass: 0.7 },
    from: 0,
    to: 1,
    durationInFrames: 14,
  });
  const cardScale = interpolate(enter, [0, 1], [0.96, 1]);

  const name = creator?.name || 'Creator';
  const handle = creator?.handle
    ? creator.handle.startsWith('@')
      ? creator.handle
      : `@${creator.handle}`
    : '@creator';

  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      {/* Blurred, dimmed base video background */}
      {videoSrc && (
        <OffthreadVideo
          src={videoSrc}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: ['blur(40px)', 'brightness(0.5)'].join(' '),
          }}
        />
      )}

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            width: '86%',
            transform: `scale(${cardScale})`,
            backgroundColor: '#15181c',
            borderRadius: 20,
            padding: '40px 40px 40px',
            boxShadow: '0 30px 90px rgba(0,0,0,0.65), 0 8px 24px rgba(0,0,0,0.55)',
            fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 26 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                overflow: 'hidden',
                backgroundColor: '#2b2f36',
                flexShrink: 0,
              }}
            >
              {creator?.avatarUrl && (
                <Img
                  src={creator.avatarUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
              <span style={{ color: '#FFFFFF', fontWeight: 800, fontSize: 34 }}>{name}</span>
              <span style={{ color: '#8b95a1', fontWeight: 500, fontSize: 28 }}>{handle}</span>
            </div>
          </div>

          {/* Body text */}
          {text && (
            <div
              style={{
                color: '#FFFFFF',
                fontSize: 40,
                lineHeight: 1.28,
                fontWeight: 500,
                marginBottom: 30,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {text}
            </div>
          )}

          {/* Sharp base-video slot (16:9) */}
          <div
            style={{
              width: '100%',
              aspectRatio: '16 / 9',
              borderRadius: 16,
              overflow: 'hidden',
              backgroundColor: '#000',
            }}
          >
            {videoSrc && (
              <OffthreadVideo
                src={videoSrc}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  transform: baseTransform,
                  transformOrigin: 'center 35%',
                  filter: baseFilterParts.length ? baseFilterParts.join(' ') : undefined,
                }}
              />
            )}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
