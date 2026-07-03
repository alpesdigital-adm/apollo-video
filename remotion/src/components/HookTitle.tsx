import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';

interface HookTitleProps {
  text?: string;
  format: '9:16' | '16:9';
  // 0-1 multiplier applied on top of the entrance-spring opacity. VideoComposition
  // drives this down to 0 (with a short ease, not a hard cut) while a full-canvas
  // scene/overlay is active (ImageInsert, AssetCard, FullScreen variant, or a
  // non-fullscreen layout segment) so the persistent headline never collides with
  // it, then eases back to 1 over talking-head / light text scenes. Defaults to 1
  // so existing callers without the prop are unaffected.
  visibility?: number;
  // Frame at which the manchete is allowed to make its entrance — the start of
  // the first headline-free window with enough runway (see
  // MIN_RUNWAY_SECONDS in VideoComposition). The entrance spring runs from
  // this frame instead of frame 0, so the title never flashes on before the
  // video actually has room for it. Defaults to 0 for existing callers.
  entranceFrame?: number;
}

/**
 * Persistent hook headline (referência v3): a fixed promise-headline pinned to
 * the top of the video for the ENTIRE duration. Enters with a spring in the
 * first ~15 frames, then holds. Two lines max, white bold with a strong shadow,
 * sitting in the ~8-16% top zone. Renders nothing when no hookTitle is set, so
 * old projects are completely unaffected.
 */
export const HookTitle: React.FC<HookTitleProps> = ({
  text,
  format,
  visibility = 1,
  entranceFrame = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return null;
  }

  const progress = spring({
    frame: Math.max(0, frame - entranceFrame),
    fps,
    from: 0,
    to: 1,
    durationInFrames: 15,
    config: { damping: 200 },
  });
  const translateY = (1 - progress) * -24;
  const isVertical = format === '9:16';
  const fontSize = isVertical ? 46 : 40;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 100 }}>
      {/* Legibility scrim: a discreet dark gradient over the top ~22% so the
          headline stays readable over bright media (b-roll / inserts). Fades in
          and out together with the title (same progress * visibility). */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '22%',
          background:
            'linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 100%)',
          opacity: progress * visibility,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: '8%',
          left: 0,
          right: 0,
          boxSizing: 'border-box',
          padding: isVertical ? '0 90px' : '0 160px',
          display: 'flex',
          justifyContent: 'center',
          opacity: progress * visibility,
          transform: `translateY(${translateY}px)`,
        }}
      >
        <div
          style={{
            fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
            fontSize,
            fontWeight: 800,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            color: '#FFFFFF',
            textAlign: 'center',
            textShadow: '0 4px 18px rgba(0,0,0,0.95), 0 2px 4px rgba(0,0,0,0.9)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            maxWidth: '92%',
          }}
        >
          {clean}
        </div>
      </div>
    </AbsoluteFill>
  );
};
