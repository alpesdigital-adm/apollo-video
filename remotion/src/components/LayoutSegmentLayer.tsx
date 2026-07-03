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
import { CreatorProfile, LayoutSegment, ColorPalette, GradePreset } from '../lib/types';
import { getGrade, getGradeOverlayLayers, composeFilter, Grade } from '../lib/grade';
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
  gradePreset?: GradePreset;
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
  gradePreset,
}) => {
  const { transform, filterParts } = useBaseVideoEffect(segment);
  const mediaSrc =
    typeof segment.props?.mediaSrc === 'string' ? (segment.props.mediaSrc as string) : '';
  const mediaMotion = useSegmentMediaMotion(segment, mediaSrc);
  // bw (grayscale) takes precedence by being summed into the filter, not
  // replacing the grade — see grade.ts composeFilter.
  const baseFilter = filterParts.length ? filterParts.join(' ') : undefined;
  const grade = getGrade(gradePreset);

  if (segment.layout === 'fullscreen') {
    // Effect-only segment: base video full-canvas with zoom / grayscale applied.
    return (
      <AbsoluteFill style={{ backgroundColor: palette.background, overflow: 'hidden' }}>
        {videoSrc && (
          <OffthreadVideo
            src={videoSrc}
            muted
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform,
              transformOrigin: 'center 35%',
              filter: composeFilter(grade.filter, baseFilter),
              backgroundColor: palette.background,
            }}
          />
        )}
        {getGradeOverlayLayers(grade).map((layer) => (
          <div key={layer.key} style={layer.style} />
        ))}
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
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center 25%',
                transform,
                transformOrigin: 'center 35%',
                filter: composeFilter(grade.filter, baseFilter),
              }}
            />
          )}
          {/* Grade overlay scoped to the base-video half only — the top-half
              media keeps its own tempero, untouched by the narrator's grade. */}
          {getGradeOverlayLayers(grade).map((layer) => (
            <div key={layer.key} style={layer.style} />
          ))}
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
            muted
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform,
              transformOrigin: 'center 35%',
              filter: composeFilter('blur(40px)', 'brightness(0.55)', grade.filter, baseFilter),
            }}
          />
        )}
        {/* Grade overlay behind the centered media card — the card keeps its
            own tempero, untouched by the narrator's grade. */}
        {getGradeOverlayLayers(grade).map((layer) => (
          <div key={layer.key} style={layer.style} />
        ))}
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
      grade={grade}
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
  grade: Grade;
}

const TweetCard: React.FC<TweetCardProps> = ({
  segment,
  videoSrc,
  palette,
  creator,
  baseTransform,
  baseFilterParts,
  grade,
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
      {/* Blurred, dimmed base video background — muted (audio comes from the
          single narrator source in VideoComposition). Heavier blur + darker
          brightness so the card reads as the clear subject. */}
      {videoSrc && (
        <OffthreadVideo
          src={videoSrc}
          muted
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: 'scale(1.1)',
            filter: composeFilter('blur(55px)', 'brightness(0.4)', grade.filter, baseFilterParts.join(' ')),
          }}
        />
      )}
      {/* Extra dark scrim to make the card pop off the background. */}
      <AbsoluteFill style={{ backgroundColor: 'rgba(0,0,0,0.28)' }} />
      {/* Grade overlay behind the card — the card itself keeps its own look. */}
      {getGradeOverlayLayers(grade).map((layer) => (
        <div key={layer.key} style={layer.style} />
      ))}

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 0' }}>
        <div
          style={{
            width: '92%',
            transform: `scale(${cardScale})`,
            backgroundColor: '#16191d',
            borderRadius: 24,
            padding: '44px 44px 48px',
            boxShadow: '0 40px 120px rgba(0,0,0,0.75), 0 12px 32px rgba(0,0,0,0.6)',
            fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
          }}
        >
          {/* Header — bigger, more breathing room */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 32 }}>
            <div
              style={{
                width: 56,
                height: 56,
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
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
              <span style={{ color: '#FFFFFF', fontWeight: 800, fontSize: 38 }}>{name}</span>
              <span style={{ color: '#8b95a1', fontWeight: 500, fontSize: 30 }}>{handle}</span>
            </div>
          </div>

          {/* Quote text */}
          {text && (
            <div
              style={{
                color: '#FFFFFF',
                fontSize: 50,
                lineHeight: 1.3,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                marginBottom: 34,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {text}
            </div>
          )}

          {/* Sharp base-video slot — 4:5 vertical-friendly, face kept via
              objectPosition center top, cover so it never distorts. Muted. */}
          <div
            style={{
              width: '100%',
              aspectRatio: '4 / 5',
              borderRadius: 24,
              overflow: 'hidden',
              backgroundColor: '#000',
            }}
          >
            {videoSrc && (
              <OffthreadVideo
                src={videoSrc}
                muted
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'center top',
                  transform: baseTransform,
                  transformOrigin: 'center 30%',
                  filter: composeFilter(grade.filter, baseFilterParts.join(' ')),
                }}
              />
            )}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
