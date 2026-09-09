import { calculateCanonicalHash } from "../domain/canonical-hash.ts";
import { assertDomain } from "../domain/errors.ts";
import {
  durationDeviation,
  validateMeasuredAlignment,
  type CanonicalScriptVersion,
  type LocalizationVariant,
  type MeasuredWord,
} from "../domain/localization.ts";
import {
  createDirectedAudioTimelineHash,
  validateDirectedEditPlan,
  type DirectedEditPlan,
  type DirectedSubtitleCue,
} from "../domain/director-run.ts";
import { calculateRenderablePlanHash } from "./renderable-edit-plan.ts";

export const LOCALIZATION_MEDIA_COMPILER_VERSION =
  "localization-media-compiler/2026-09-08-v1" as const;

export interface CompileLocalizationMediaInput {
  variant: Readonly<LocalizationVariant>;
  canonical: Readonly<CanonicalScriptVersion>;
  basePlan: Readonly<DirectedEditPlan>;
  audio: Readonly<{
    artifactId: string;
    sha256: string;
    rightsSnapshotId: string;
    durationMs: number;
    words: readonly MeasuredWord[];
    alignmentArtifactId: string;
    alignmentSha256: string;
  }>;
  blockWordRanges: readonly Readonly<{
    blockId: string;
    startWord: number;
    endWord: number;
  }>[];
  format: string;
  planId: string;
  createdAt: string;
}

function frame(ms: number, fps: number) {
  return Math.round((ms * fps) / 1000);
}
export function compileLocalizationMedia(input: CompileLocalizationMediaInput) {
  const { variant, canonical, basePlan, audio } = input;
  assertDomain(
    variant.status === "audio" &&
      variant.stage === "translation-reviewed" &&
      variant.localizedBlocks?.every(
        (block) => block.reviewStatus === "human-approved",
      ),
    "PRECONDITION_REQUIRED",
    "Localization media requires the exact human-reviewed translation revision",
  );
  assertDomain(
    variant.canonicalScriptVersionId === canonical.id &&
      variant.canonicalContentHash === canonical.contentHash &&
      basePlan.projectVersionId === canonical.projectVersionId,
    "VERSION_CONFLICT",
    "Localization media inputs do not share one immutable canonical authority",
  );
  assertDomain(
    variant.mode === "subtitles-only"
      ? audio.artifactId === variant.originalAudioAssetId
      : ["local-voice", "uploaded"].includes(variant.mode) &&
          audio.artifactId !== variant.originalAudioAssetId,
    "PRECONDITION_REQUIRED",
    "Localization audio does not match the authorized mode",
  );
  const words = validateMeasuredAlignment(audio.words, audio.durationMs);
  assertDomain(
    input.blockWordRanges.length === canonical.blocks.length &&
      input.blockWordRanges.every(
        (range, index) =>
          range.blockId === canonical.blocks[index]?.id &&
          Number.isSafeInteger(range.startWord) &&
          Number.isSafeInteger(range.endWord) &&
          range.startWord >= 0 &&
          range.endWord > range.startWord &&
          range.endWord <= words.length &&
          (index === 0
            ? range.startWord === 0
            : range.startWord === input.blockWordRanges[index - 1]!.endWord) &&
          (index !== input.blockWordRanges.length - 1 ||
            range.endWord === words.length),
      ),
    "PRECONDITION_REQUIRED",
    "Measured block ranges must cover canonical blocks in order",
  );
  const blockDurations = input.blockWordRanges.map((range) => ({
    blockId: range.blockId,
    durationMs:
      words[range.endWord - 1]!.endMs - words[range.startWord]!.startMs,
  }));
  const deviation = durationDeviation(canonical, blockDurations);
  const clips = basePlan.videoTracks.find(
    (track) => track.kind === "base-video",
  )!.clips;
  // Subtitles-only is not dubbing: picture and original sound retain the exact
  // base timeline. A localized voice is a different mapping problem and must
  // not be approximated by globally stretching every source clip.
  assertDomain(
    variant.mode === "subtitles-only",
    "PRECONDITION_REQUIRED",
    "Localized voice rendering requires a measured clip mapping and is not supported by this processor",
  );
  const durationFrames = basePlan.durationFrames;
  const sourceDurationFrames = clips.reduce(
    (sum, clip) => sum + clip.timelineOutFrame - clip.timelineInFrame,
    0,
  );
  assertDomain(
    sourceDurationFrames > 0,
    "INVALID_RENDER_INPUT",
    "Base localization plan has no measurable video",
  );
  const localizedClips = clips.map((clip) => Object.freeze({ ...clip }));
  const maxChars = basePlan.subtitlePolicy.maxCharactersPerBlock;
  const cues: DirectedSubtitleCue[] = [];
  let cueWords: { word: string; startMs: number; endMs: number }[] = [];
  const flush = () => {
    if (!cueWords.length) return;
    cues.push(
      Object.freeze({
        id: `localized-cue-${cues.length + 1}`,
        startFrame: frame(cueWords[0]!.startMs, basePlan.fps),
        endFrame: Math.min(
          durationFrames,
          Math.max(
            frame(cueWords.at(-1)!.endMs, basePlan.fps),
            frame(cueWords[0]!.startMs, basePlan.fps) + 1,
          ),
        ),
        text: cueWords.map((word) => word.word).join(" "),
        anchor: "bottom",
      }),
    );
    cueWords = [];
  };
  for (const [blockIndex, range] of input.blockWordRanges.entries()) {
    const approvedText = variant.localizedBlocks![blockIndex]!.text.trim();
    const translatedWords = approvedText.split(/\s+/u);
    const startMs = words[range.startWord]!.startMs;
    const endMs = words[range.endWord - 1]!.endMs;
    const span = endMs - startMs;
    for (const [wordIndex, word] of translatedWords.entries()) {
      const measured = {
        word,
        startMs: startMs + Math.floor((span * wordIndex) / translatedWords.length),
        endMs: startMs + Math.floor((span * (wordIndex + 1)) / translatedWords.length),
      };
      const text = [...cueWords, measured].map((item) => item.word).join(" ");
      if (cueWords.length && text.length > maxChars) flush();
      cueWords.push(measured);
    }
    flush();
  }
  flush();
  const audioTimelineHash = createDirectedAudioTimelineHash({
    fps: basePlan.fps,
    clips: localizedClips,
    musicTracks: basePlan.audioTracks,
  });
  const planBody: DirectedEditPlan = {
    ...basePlan,
    id: input.planId,
    durationFrames,
    videoTracks: Object.freeze([
      { ...basePlan.videoTracks[0]!, clips: Object.freeze(localizedClips) },
    ]),
    subtitleTracks: Object.freeze([
      {
        id: `localized-subtitles-${variant.id}`,
        kind: "captions",
        presetId: basePlan.subtitleTracks[0]?.presetId ?? "clean-color",
        anchor: "bottom",
        faceProtection: true,
        maxLines: 2,
        maxCharactersPerBlock: maxChars,
        desiredActionRef: basePlan.desiredActionRef,
        cues: Object.freeze(cues),
      },
    ]),
    localeVariantRefs: Object.freeze([variant.id]) as never,
    formatVariantRefs: Object.freeze([input.format]) as never,
    lineageRefs: Object.freeze(
      [
        ...new Set([
          ...basePlan.lineageRefs,
          `localization:${variant.id}:${variant.variantHash}`,
          `audio:${audio.artifactId}:${audio.sha256}`,
          `alignment:${audio.alignmentArtifactId}:${audio.alignmentSha256}`,
        ]),
      ].sort(),
    ),
    retimedTranscript: Object.freeze({
      sourceTranscriptId: audio.alignmentArtifactId,
      words: Object.freeze(
        words.map((word) => ({
          text: word.word,
          sourceStartSeconds: word.startMs / 1000,
          sourceEndSeconds: word.endMs / 1000,
          timelineStartFrame: frame(word.startMs, basePlan.fps),
          timelineEndFrame: frame(word.endMs, basePlan.fps),
        })),
      ),
    }),
    transitions: Object.freeze(
      localizedClips
        .slice(0, -1)
        .map((clip, index) => ({
          ...basePlan.transitions[index]!,
          atFrame: clip.timelineOutFrame,
        })),
    ),
    audioTimelineHash,
    director: Object.freeze({
      ...basePlan.director,
      plannerVersion: LOCALIZATION_MEDIA_COMPILER_VERSION,
      assumptions: Object.freeze([
        ...basePlan.director.assumptions,
        deviation.thresholdExceeded
          ? "Localized measured audio exceeded the 15% block threshold; timeline was reflowed."
          : "Localized measured audio remained within the configured 15% block threshold.",
      ]),
    }),
    createdAt: input.createdAt,
  };
  const plan = validateDirectedEditPlan(Object.freeze(planBody));
  const planHash = calculateRenderablePlanHash(plan);
  return Object.freeze({
    plan,
    planHash,
    blockDurations: Object.freeze(blockDurations),
    durationDeviation: Object.freeze({ ...deviation, threshold: 0.15 }),
    lineageHash: calculateCanonicalHash({
      compilerVersion: LOCALIZATION_MEDIA_COMPILER_VERSION,
      variantHash: variant.variantHash,
      canonicalContentHash: canonical.contentHash,
      basePlanId: basePlan.id,
      planHash,
      audioSha256: audio.sha256,
      alignmentSha256: audio.alignmentSha256,
      format: input.format,
    }),
  });
}
