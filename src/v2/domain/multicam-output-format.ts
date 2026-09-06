/**
 * The output formats a multicam direction may be cut for (F4.012).
 *
 * A leaf on purpose. `multicam-direction.ts` reaches `canonical-hash.ts`, which
 * reaches `node:crypto`, so the module that owns the direction cannot be
 * imported by a browser page — and an operator surface that offers a format
 * picker has to offer exactly the formats the domain accepts. Typing the four
 * strings a second time into the page is how the Wave 19 injury happened: every
 * enum written from memory was wrong. So the vocabulary lives here, with no
 * import of its own, and both sides read the same constant.
 *
 * These four are the multicam vocabulary and are deliberately not the five in
 * `output-spec.ts`: a final render may be delivered at `21:9`, and a re-cut
 * across cameras may not, because the framing rules that pick an angle are
 * calibrated for the four here.
 */

export const OUTPUT_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1', '4:5'] as const)
export type OutputAspectRatio = (typeof OUTPUT_ASPECT_RATIOS)[number]
