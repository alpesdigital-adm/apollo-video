import test from "node:test";
import assert from "node:assert/strict";
import {
  createCanonicalScriptVersion,
  durationDeviation,
  resolveLocalizedAudioMode,
  validateLocalizedBlocks,
  validateMeasuredAlignment,
} from "../../src/v2/domain/localization.ts";
const canonical = createCanonicalScriptVersion({
  id: "canonical-001",
  workspaceId: "workspace-001",
  projectId: "project-001",
  projectVersionId: "version-001",
  sourceLocale: "pt-BR",
  revision: 1,
  approvedByClientId: "client-001",
  approvedAt: "2026-09-08T12:00:00.000Z",
  blocks: [
    {
      id: "canonical-block-001",
      sourceScriptBlockId: "script-block-1",
      role: "offer",
      sourceLocale: "pt-BR",
      text: "Somente R$ 27 até sexta em https://x.test",
      sourceRangeMs: [1000, 5000],
      sourceAlignmentId: "alignment-001",
      claims: [
        { id: "price", text: "R$ 27", qualifier: "Somente", protected: true },
      ],
      qualifiers: [{ id: "only", text: "Somente" }],
      protectedFacts: [{ id: "deadline", text: "sexta" }],
      cta: { action: "buy", destination: "https://x.test" },
      dependencies: [],
      adaptationLevel: "meaning-preserving",
    },
  ],
});
test("T-FR-190 protects semantic claims, qualifiers, facts and CTA destinations", () => {
  assert.throws(
    () =>
      validateLocalizedBlocks(canonical, [
        {
          blockId: "canonical-block-001",
          text: "Only $270 until Friday at https://x.test",
          protectedValues: { price: "$27", only: "Only", deadline: "Friday" },
          reviewStatus: "human-approved",
        },
      ]),
    /Protected semantic value/,
  );
  assert.doesNotThrow(() =>
    validateLocalizedBlocks(canonical, [
      {
        blockId: "canonical-block-001",
        text: "Only $27 until Friday. Buy: https://x.test",
        protectedValues: { price: "$27", only: "Only", deadline: "Friday" },
        reviewStatus: "human-approved",
      },
    ]),
  );
});
test("T-FR-192 only accepts measured monotonic alignment", () => {
  assert.equal(
    validateMeasuredAlignment(
      [
        { word: "hello", startMs: 90, endMs: 230, confidence: 0.97 },
        { word: "world", startMs: 410, endMs: 780, confidence: 0.92 },
      ],
      900,
    ).length,
    2,
  );
  assert.throws(
    () =>
      validateMeasuredAlignment(
        [
          { word: "a", startMs: 0, endMs: 500, confidence: 1 },
          { word: "b", startMs: 400, endMs: 900, confidence: 1 },
        ],
        900,
      ),
    /monotonic/,
  );
});
test("T-FR-192 forces reflow above fifteen percent", () => {
  assert.equal(
    durationDeviation(canonical, [
      { blockId: "canonical-block-001", durationMs: 4400 },
    ]).thresholdExceeded,
    false,
  );
  assert.equal(
    durationDeviation(canonical, [
      { blockId: "canonical-block-001", durationMs: 4800 },
    ]).thresholdExceeded,
    true,
  );
});
test("T-FR-192 rejects duplicate, extra and invalid duration inputs", () => {
  assert.throws(
    () =>
      durationDeviation(canonical, [
        { blockId: "canonical-block-001", durationMs: 4000 },
        { blockId: "other", durationMs: 99999 },
      ]),
    /exactly once/,
  );
  assert.throws(
    () =>
      durationDeviation(
        canonical,
        [{ blockId: "canonical-block-001", durationMs: 4000 }],
        Number.NaN,
      ),
    /threshold/,
  );
});
test("T-FR-193 unavailable or unauthorized mode fails closed", () => {
  assert.throws(
    () =>
      resolveLocalizedAudioMode({
        preferred: "lip-sync",
        allowedModes: ["lip-sync", "subtitles-only"],
        providerCapabilities: [],
        localeSupported: true,
        voiceAuthorized: true,
        visualAuthorized: true,
        testimonial: false,
        disclosureRequired: false,
      }),
    /not authorized or available/,
  );
  assert.throws(
    () =>
      resolveLocalizedAudioMode({
        preferred: "authorized-tts",
        allowedModes: ["authorized-tts"],
        providerCapabilities: ["authorized-tts"],
        localeSupported: true,
        voiceAuthorized: false,
        visualAuthorized: true,
        testimonial: false,
        disclosureRequired: true,
      }),
    /not authorized or available/,
  );
  assert.equal(
    resolveLocalizedAudioMode({
      preferred: "subtitles-only",
      allowedModes: ["subtitles-only"],
      providerCapabilities: [],
      localeSupported: true,
      voiceAuthorized: false,
      visualAuthorized: false,
      testimonial: true,
      disclosureRequired: false,
    }).mode,
    "subtitles-only",
  );
});
