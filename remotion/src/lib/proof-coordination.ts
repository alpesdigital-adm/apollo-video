import type { Scene } from './types';

export function isProofPresentationActive(
  scenes: readonly Scene[],
  frame: number,
  fps: number,
): boolean {
  return scenes.some((scene) => {
    if (scene.type !== 'proof-presentation') return false;
    const start = scene.fromFrame ??
      Math.round(scene.from * fps);
    const end = scene.toFrame ??
      Math.round(scene.to * fps);
    return frame >= start && frame < end;
  });
}
