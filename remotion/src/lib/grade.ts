import type { CSSProperties } from 'react';

/**
 * Color grade presets applied to the narrator's base video (the raw talking-head
 * footage). Independent of the per-scene filters already used by ImageInsert /
 * AssetCard (those keep their own "tempero" and are NOT touched here).
 *
 * 'natural' is the DEFAULT — the raw footage looks flat/undergraded without it,
 * so an absent preference resolves to 'natural', not 'off'.
 */
export type GradePreset = 'natural' | 'cinema' | 'quente' | 'frio' | 'off';

export const GRADE_PRESETS: GradePreset[] = ['natural', 'cinema', 'quente', 'frio', 'off'];

export function isValidGradePreset(value: unknown): value is GradePreset {
  return typeof value === 'string' && (GRADE_PRESETS as string[]).includes(value);
}

export interface GradeTintOverlay {
  background: string;
  mixBlendMode: CSSProperties['mixBlendMode'];
  opacity: number;
}

export interface Grade {
  /** CSS filter() value applied to the base video element. Empty string = no filter. */
  filter: string;
  /** Vignette strength, 0 = none. Rendered as a radial-gradient overlay. */
  vignette: number;
  /** Optional subtle color-wash layers (e.g. cinema's teal/orange split-tone). */
  tintOverlays?: GradeTintOverlay[];
}

const GRADES: Record<GradePreset, Grade> = {
  natural: {
    filter: 'contrast(1.06) saturate(1.08) brightness(1.02)',
    vignette: 0.18
  },
  cinema: {
    // Subtle contrast bump, no crushed saturation — the teal/orange split-tone
    // does the work instead of a heavy-handed global saturate() push.
    filter: 'contrast(1.09) saturate(1.05)',
    vignette: 0.2,
    tintOverlays: [
      // Teal into the shadows: multiply darkens more where the image is already
      // dark, so the tint reads mainly in shadow regions.
      { background: '#0a2a33', mixBlendMode: 'multiply', opacity: 0.1 },
      // Orange into the highlights: screen brightens more where the image is
      // already bright, so the tint reads mainly in skin/highlight regions.
      { background: '#ff8c3c', mixBlendMode: 'screen', opacity: 0.05 }
    ]
  },
  quente: {
    filter: 'sepia(0.08) saturate(1.1) brightness(1.03)',
    vignette: 0.15
  },
  frio: {
    filter: 'saturate(0.95) contrast(1.07)',
    vignette: 0.18,
    tintOverlays: [{ background: '#2a4a6e', mixBlendMode: 'overlay', opacity: 0.08 }]
  },
  off: {
    filter: '',
    vignette: 0
  }
};

/** Resolve a (possibly missing/invalid) preset string into a Grade. Default: 'natural'. */
export function getGrade(preset?: string | null): Grade {
  if (isValidGradePreset(preset)) return GRADES[preset];
  return GRADES.natural;
}

/** Join filter fragments, skipping empty/falsy ones, and return undefined if nothing remains. */
export function composeFilter(...parts: Array<string | undefined | null | false>): string | undefined {
  const joined = parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .trim();
  return joined.length > 0 ? joined : undefined;
}

export interface GradeOverlayLayer {
  key: string;
  style: CSSProperties;
}

/**
 * Renderable overlay layers (tint washes + vignette) for a Grade, as plain
 * style objects — kept out of JSX so this module stays a pure .ts file.
 * Consumers map these onto <div style={layer.style} /> positioned above the
 * video and below scenes/subtitles.
 */
export function getGradeOverlayLayers(grade: Grade): GradeOverlayLayer[] {
  const layers: GradeOverlayLayer[] = [];

  (grade.tintOverlays || []).forEach((tint, index) => {
    layers.push({
      key: `grade-tint-${index}`,
      style: {
        position: 'absolute',
        inset: 0,
        background: tint.background,
        mixBlendMode: tint.mixBlendMode,
        opacity: tint.opacity,
        pointerEvents: 'none'
      }
    });
  });

  if (grade.vignette > 0) {
    layers.push({
      key: 'grade-vignette',
      style: {
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,${grade.vignette}) 100%)`,
        pointerEvents: 'none'
      }
    });
  }

  return layers;
}
