import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';

interface FlashTransitionProps {
  startFrame: number;
}

/**
 * Pacote 5 — flash transition. A full-screen warm-white burst that pops
 * opacity 0 → 0.9 → 0 over ~7 frames centered on `startFrame`, with a quick
 * backdrop blur so the incoming content smears through the flash. Deterministic
 * (frame-driven only); renders nothing outside its short window.
 */
export const FlashTransition: React.FC<FlashTransitionProps> = ({ startFrame }) => {
  const frame = useCurrentFrame();
  const local = frame - startFrame;

  // Centered ~7-frame window: [-4, +4] around the scene's entrance.
  if (local < -4 || local > 4) {
    return null;
  }

  const opacity = interpolate(local, [-4, 0, 4], [0, 0.9, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const blur = interpolate(local, [-4, 0, 4], [0, 8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#FFF8E7',
        opacity,
        backdropFilter: blur > 0.1 ? `blur(${blur}px)` : undefined,
        WebkitBackdropFilter: blur > 0.1 ? `blur(${blur}px)` : undefined,
        pointerEvents: 'none',
      }}
    />
  );
};
