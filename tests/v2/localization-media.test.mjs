import test from "node:test";
import assert from "node:assert/strict";
import { calculateCanonicalHash } from "../../src/v2/domain/canonical-hash.ts";
import { createCanonicalScriptVersion } from "../../src/v2/domain/localization.ts";
import {
  createDesiredAction,
  createDesiredActionReference,
} from "../../src/v2/domain/desired-action.ts";
import { createDirectedAudioTimelineHash } from "../../src/v2/domain/director-run.ts";
import {
  approveLocalizationMediaRun,
  beginLocalizationMediaRun,
  createLocalizationMediaRun,
  recordLocalizationMediaEvidence,
} from "../../src/v2/domain/localization-media-run.ts";
import { compileLocalizationMedia } from "../../src/v2/application/compile-localization-media.ts";
import { createLocalizationMediaProcessor } from "../../src/v2/application/localization-media-processor.ts";
import { approveLocalizationMediaService } from "../../src/v2/application/localization-media.ts";

const sha = (c) => c.repeat(64);
const at = "2026-09-08T19:30:00.000Z";
const canonical = createCanonicalScriptVersion({
  id: "canonical-001",
  workspaceId: "workspace-001",
  projectId: "project-001",
  projectVersionId: "version-001",
  sourceLocale: "pt-BR",
  revision: 1,
  approvedByClientId: "human-001",
  approvedAt: at,
  blocks: [
    {
      id: "canonical-block-001",
      sourceScriptBlockId: "script-block-001",
      role: "body",
      sourceLocale: "pt-BR",
      text: "Uma frase curta",
      sourceRangeMs: [0, 4000],
      sourceAlignmentId: "alignment-source-001",
      claims: [],
      qualifiers: [],
      protectedFacts: [],
      dependencies: [],
      adaptationLevel: "meaning-preserving",
    },
  ],
});
const desiredActionRef = createDesiredActionReference(
  createDesiredAction({ objective: "awareness" }),
);
const clip = {
  id: "clip-001",
  sourceArtifactId: "video-001",
  sourceInFrame: 0,
  sourceOutFrame: 120,
  timelineInFrame: 0,
  timelineOutFrame: 120,
  rate: 1,
};
const basePlan = {
  schemaVersion: 2,
  state: "compiled",
  id: "plan-base-001",
  projectVersionId: "version-001",
  storyPlanId: "story-001",
  treatmentPlanId: "treatment-001",
  directorRunId: "director-001",
  fps: 30,
  durationFrames: 120,
  sources: [
    {
      id: "source-001",
      artifactId: "video-001",
      kind: "video",
      durationSeconds: 4,
    },
  ],
  videoTracks: [{ id: "video-track-001", kind: "base-video", clips: [clip] }],
  audioTimelineHash: createDirectedAudioTimelineHash({
    fps: 30,
    clips: [clip],
    musicTracks: [],
  }),
  desiredActionRef,
  overlayTracks: [],
  subtitleTracks: [],
  audioTracks: [],
  effectTracks: [],
  transitions: [],
  markers: [],
  protectedElements: [],
  localeVariantRefs: [],
  formatVariantRefs: [],
  lineageRefs: ["director:director-001"],
  editorial: {
    commandType: "source-ingest",
    exclusions: [],
    retainedSourceRanges: [{ sourceStartSeconds: 0, sourceEndSeconds: 4 }],
  },
  retimedTranscript: { sourceTranscriptId: "transcript-001", words: [] },
  movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
  subtitlePolicy: {
    faceProtection: true,
    anchor: "bottom",
    maxCharactersPerBlock: 32,
  },
  composition: {
    layout: "landscape-inset",
    background: "blurred-source",
    foregroundScale: 1,
    verticalPosition: 0.5,
    faceSafeFallback: [0.14, 0.08, 0.72, 0.56],
    subtitleSafeRegion: [0.08, 0.7, 0.84, 0.24],
  },
  director: { plannerVersion: "director/v1", decisions: [], assumptions: [] },
  createdAt: at,
};
function variant(mode = "uploaded") {
  const body = {
    id: "variant-001",
    workspaceId: "workspace-001",
    projectId: "project-001",
    canonicalScriptVersionId: canonical.id,
    canonicalContentHash: canonical.contentHash,
    targetLocale: "en-US",
    mode,
    formats: ["9:16"],
    originalAudioAssetId: "audio-original-001",
    status: "audio",
    stage: "translation-reviewed",
    revision: 3,
    localizedBlocks: [
      {
        blockId: "canonical-block-001",
        text: "This is a deliberately longer sentence",
        protectedValues: {},
        reviewStatus: "human-approved",
      },
    ],
    createdByClientId: "client-001",
    createdAt: at,
    updatedAt: at,
  };
  return Object.freeze({ ...body, variantHash: calculateCanonicalHash(body) });
}
const words = [
  { word: "Uma", startMs: 0, endMs: 500, confidence: 0.99 },
  { word: "frase", startMs: 600, endMs: 1500, confidence: 0.99 },
  { word: "curta", startMs: 1600, endMs: 3800, confidence: 0.99 },
];

test("T-FR-192 compiles approved translated subtitles on the unchanged source timeline", () => {
  const result = compileLocalizationMedia({
    variant: variant("subtitles-only"),
    canonical,
    basePlan,
    audio: {
      artifactId: "audio-original-001",
      sha256: sha("a"),
      rightsSnapshotId: "rights-001",
      durationMs: 4000,
      words,
      alignmentArtifactId: "alignment-localized-001",
      alignmentSha256: sha("b"),
    },
    blockWordRanges: [
      { blockId: "canonical-block-001", startWord: 0, endWord: words.length },
    ],
    format: "9:16",
    planId: "localized-plan-001",
    createdAt: at,
  });
  assert.equal(result.plan.durationFrames, 120);
  assert.equal(result.durationDeviation.thresholdExceeded, false);
  assert.equal(
    result.plan.videoTracks[0].clips[0].timelineOutFrame,
    120,
  );
  assert.equal(result.plan.localeVariantRefs[0], "variant-001");
  assert.ok(result.plan.subtitleTracks[0].cues.length >= 2);
  assert.match(
    result.plan.subtitleTracks[0].cues.map((cue) => cue.text).join(" "),
    /This is a deliberately longer sentence/,
  );
  assert.match(result.lineageHash, /^[a-f0-9]{64}$/);
});

test("T-FR-193 refuses original audio as uploaded/local voice and permits it only for subtitles-only", () => {
  const common = {
    canonical,
    basePlan,
    audio: {
      artifactId: "audio-original-001",
      sha256: sha("a"),
      rightsSnapshotId: "rights-001",
      durationMs: 4000,
      words,
      alignmentArtifactId: "alignment-localized-001",
      alignmentSha256: sha("b"),
    },
    blockWordRanges: [
      { blockId: "canonical-block-001", startWord: 0, endWord: words.length },
    ],
    format: "9:16",
    planId: "localized-plan-001",
    createdAt: at,
  };
  assert.throws(
    () => compileLocalizationMedia({ ...common, variant: variant("uploaded") }),
    /authorized mode|measured clip mapping/,
  );
  assert.doesNotThrow(() =>
    compileLocalizationMedia({ ...common, variant: variant("subtitles-only") }),
  );
});

test("T-FR-195 approval is fenced behind measured render evidence", () => {
  const requested = createLocalizationMediaRun({
    id: "media-run-001",
    workspaceId: "workspace-001",
    projectId: "project-001",
    variantId: "variant-001",
    variantRevision: 3,
    variantHash: variant().variantHash,
    canonicalContentHash: canonical.contentHash,
    source: {
      kind: "uploaded-audio",
      artifactId: "audio-upload-001",
      artifactSha256: sha("a"),
      rightsSnapshotId: "rights-001",
    },
    requestedByClientId: "client-001",
    at,
  });
  assert.throws(
    () => approveLocalizationMediaRun(requested, { clientId: "human-001", at }),
    /measured rendered/,
  );
  const processing = beginLocalizationMediaRun(
    requested,
    "2026-09-08T19:31:00.000Z",
  );
  const reviewed = recordLocalizationMediaEvidence(
    processing,
    {
      audioArtifactId: "audio-upload-001",
      audioSha256: sha("a"),
      durationMs: 6000,
      alignmentArtifactId: "alignment-localized-001",
      alignmentSha256: sha("b"),
      words,
      blockDurations: [{ blockId: "canonical-block-001", durationMs: 5600 }],
      durationDeviation: {
        totalRatio: 1.4,
        threshold: 0.15,
        thresholdExceeded: true,
        byBlock: [
          { blockId: "canonical-block-001", ratio: 1.4, requiresReflow: true },
        ],
      },
      renderablePlans: [
        {
          format: "9:16",
          snapshotId: "snapshot-001",
          planHash: sha("c"),
          proxyOperationId: "operation-001",
          proxyArtifactId: "proxy-001",
        },
      ],
      lineageHash: sha("d"),
    },
    "2026-09-08T19:32:00.000Z",
  );
  assert.equal(
    approveLocalizationMediaRun(reviewed, {
      clientId: "human-001",
      at: "2026-09-08T19:33:00.000Z",
    }).status,
    "approved",
  );
});

test("T-FR-195 approval replay is bound to the full actor context and normalized payload before mutable reads", async () => {
  let reads = 0, replayInput;
  const approved = { id: "media-run-replay", status: "approved" };
  const service = approveLocalizationMediaService({ clock: () => new Date(at), runs: {
    async findApprovalReplay(input) { replayInput = input; return approved; },
    async read() { reads += 1; assert.fail("a committed replay must not reread mutable state"); },
  } });
  const result = await service({ workspaceId: "workspace-001", projectId: "project-001", variantId: "variant-001", runId: "media-run-replay", expectedRevision: 3, expectedRunHash: sha("a"), actorClientId: "client-001", authenticationAudit: { contextHash: sha("b") }, idempotencyKey: "approval-replay", note: "  checked  " });
  assert.equal(result, approved); assert.equal(reads, 0); assert.equal(replayInput.actorContextHash, sha("b")); assert.equal(replayInput.requestFingerprint.length, 64);
});

test("T-FR-192 processor persists the exact plan and requires a real proxy artifact result", async () => {
  const requested = createLocalizationMediaRun({
    id: "media-run-processor", workspaceId: "workspace-001", projectId: "project-001",
    variantId: "variant-001", variantRevision: 3, variantHash: variant("subtitles-only").variantHash,
    canonicalContentHash: canonical.contentHash,
    source: { kind: "original-audio", artifactId: "audio-original-001", artifactSha256: sha("a"), rightsSnapshotId: "rights-001" },
    requestedByClientId: "client-001", at,
  });
  const processing = beginLocalizationMediaRun(requested, "2026-09-08T19:31:00.000Z");
  let persistedPlanHash;
  const processor = createLocalizationMediaProcessor({
    clock: () => new Date("2026-09-08T19:31:30.000Z"), createId: () => "localized-plan-processor",
    contexts: { async load() { return { variant: variant("subtitles-only"), canonical, basePlan, audio: { artifactId: "audio-original-001", sha256: sha("a"), rightsSnapshotId: "rights-001", durationMs: 4000, words, alignmentArtifactId: "alignment-original-001", alignmentSha256: sha("b") }, blockWordRanges: [{ blockId: "canonical-block-001", startWord: 0, endWord: words.length }] }; } },
    snapshots: { async persist({ snapshot, createdAt }) { persistedPlanHash = snapshot.planHash; return { snapshot: { ...snapshot, createdAt }, replayed: false }; } },
    proxy: { async render(input) { assert.equal(input.planHash, persistedPlanHash); return { operationId: "localization-proxy-operation", artifactId: "localization-proxy-artifact" }; } },
  });
  const evidence = await processor.process(processing, new AbortController().signal);
  assert.equal(evidence.renderablePlans[0].proxyArtifactId, "localization-proxy-artifact");
  assert.equal(evidence.renderablePlans[0].planHash, persistedPlanHash);
});
