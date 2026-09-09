import { calculateCanonicalHash } from "./canonical-hash.ts";
import { assertDomain, DomainError } from "./errors.ts";
import type { ScriptBlockRole } from "./script-alignment.ts";
import { OUTPUT_ASPECT_RATIOS } from "./multicam-output-format.ts";
import {
  LOCALIZED_AUDIO_MODES,
  type LocalizedAudioMode,
} from "./localization-contract.ts";

export {
  LOCALIZED_AUDIO_MODES,
  type LocalizedAudioMode,
} from "./localization-contract.ts";

export const LOCALIZATION_SCHEMA_VERSION = "localization/v1" as const;
export const ADAPTATION_LEVELS = [
  "literal-required",
  "meaning-preserving",
  "cultural-adaptation",
  "rewrite-allowed",
] as const;
export const LOCALIZATION_STATUSES = [
  "draft",
  "translating",
  "audio",
  "visual",
  "review",
  "approved",
  "failed",
  "blocked",
  "stale",
  "cancelled",
] as const;
export type AdaptationLevel = (typeof ADAPTATION_LEVELS)[number];
export type LocalizationStatus = (typeof LOCALIZATION_STATUSES)[number];
export type MeasuredWord = Readonly<{
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}>;
export interface CanonicalLocalizationBlock {
  id: string;
  sourceScriptBlockId: string;
  role: ScriptBlockRole;
  sourceLocale: string;
  text: string;
  sourceRangeMs: readonly [number, number];
  sourceAlignmentId: string;
  claims: readonly Readonly<{
    id: string;
    text: string;
    qualifier?: string;
    attribution?: string;
    protected: boolean;
  }>[];
  qualifiers: readonly Readonly<{ id: string; text: string }>[];
  protectedFacts: readonly Readonly<{ id: string; text: string }>[];
  cta?: Readonly<{ action: string; destination: string }>;
  dependencies: readonly string[];
  adaptationLevel: AdaptationLevel;
  blockHash: string;
}
export interface CanonicalScriptVersion {
  id: string;
  workspaceId: string;
  projectId: string;
  projectVersionId: string;
  sourceLocale: string;
  revision: number;
  blocks: readonly CanonicalLocalizationBlock[];
  approvedByClientId: string;
  approvedAt: string;
  contentHash: string;
}
export interface LocalizationVariant {
  id: string;
  workspaceId: string;
  projectId: string;
  canonicalScriptVersionId: string;
  canonicalContentHash: string;
  targetLocale: string;
  market?: string;
  mode: LocalizedAudioMode;
  formats: readonly string[];
  originalAudioAssetId: string;
  localizedAudioAssetId?: string;
  alignment?: readonly MeasuredWord[];
  status: LocalizationStatus;
  stage: string;
  revision: number;
  localizedBlocks?: readonly Readonly<{
    blockId: string;
    text: string;
    durationMs?: number;
    protectedValues?: Readonly<Record<string, string>>;
    reviewStatus?: "machine-translated" | "human-approved";
  }>[];
  translationProvenance?: Readonly<{
    runId: string;
    runHash: string;
    translationHash: string;
    providerId: string;
    adapterVersion: string;
    model: string;
    configHash: string;
  }>;
  durationDeviation?: Readonly<{
    totalRatio: number;
    byBlock: readonly Readonly<{
      blockId: string;
      ratio: number;
      requiresReflow: boolean;
    }>[];
  }>;
  dependentPlan?: Readonly<{
    captionIds: readonly string[];
    clipIds: readonly string[];
    brollIds: readonly string[];
    eventIds: readonly string[];
  }>;
  disclosure?: string;
  approval?: Readonly<{ clientId: string; at: string; revision: number }>;
  failure?: Readonly<{ code: string; message: string; retryable: boolean }>;
  createdByClientId: string;
  createdAt: string;
  updatedAt: string;
  variantHash: string;
}
export function assertLocalizationVariantIntegrity(
  value: Readonly<LocalizationVariant>,
) {
  identity(value.id, "variant.id");
  identity(value.workspaceId, "variant.workspaceId");
  identity(value.projectId, "variant.projectId");
  identity(value.canonicalScriptVersionId, "variant.canonicalScriptVersionId");
  identity(value.originalAudioAssetId, "variant.originalAudioAssetId");
  identity(value.createdByClientId, "variant.createdByClientId");
  canonicalLocale(value.targetLocale);
  instant(value.createdAt, "variant.createdAt");
  instant(value.updatedAt, "variant.updatedAt");
  assertDomain(
    LOCALIZATION_STATUSES.includes(value.status) &&
      LOCALIZED_AUDIO_MODES.includes(value.mode),
    "PERSISTENCE_CONFLICT",
    "Localization status or mode is invalid",
  );
  assertDomain(
    Number.isSafeInteger(value.revision) && value.revision >= 1,
    "PERSISTENCE_CONFLICT",
    "Localization revision is invalid",
  );
  assertDomain(
    value.formats.length > 0 &&
      new Set(value.formats).size === value.formats.length &&
      value.formats.every((format) =>
        OUTPUT_ASPECT_RATIOS.includes(
          format as (typeof OUTPUT_ASPECT_RATIOS)[number],
        ),
      ),
    "PERSISTENCE_CONFLICT",
    "Localization formats are invalid",
  );
  const expected = calculateCanonicalHash({ ...value, variantHash: undefined });
  assertDomain(
    value.variantHash === expected,
    "PERSISTENCE_CONFLICT",
    "Localization variant content hash is inconsistent",
  );
  return immutableJson(value);
}
const TRANSITIONS: Readonly<
  Record<LocalizationStatus, readonly LocalizationStatus[]>
> = {
  draft: ["translating", "cancelled"],
  translating: ["audio", "failed", "blocked", "cancelled"],
  audio: ["visual", "failed", "blocked", "cancelled"],
  visual: ["review", "failed", "blocked", "cancelled"],
  review: ["approved", "audio", "visual", "failed", "blocked", "cancelled"],
  approved: ["stale"],
  failed: ["translating", "cancelled"],
  blocked: ["translating", "cancelled"],
  stale: ["draft", "cancelled"],
  cancelled: [],
};
export function canonicalLocale(value: string) {
  try {
    return Intl.getCanonicalLocales(value.trim())[0]!;
  } catch {
    throw new DomainError("INVALID_ARGUMENT", "Locale is invalid");
  }
}
function identity(value: string, field: string) {
  assertDomain(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/.test(value),
    "INVALID_ARGUMENT",
    `${field} is invalid`,
  );
  return value;
}
function instant(value: string, field: string) {
  const parsed = new Date(value);
  assertDomain(
    typeof value === "string" &&
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString() === value,
    "INVALID_ARGUMENT",
    `${field} must be an ISO instant`,
  );
  return value;
}
function validRange(value: readonly [number, number]) {
  assertDomain(
    Number.isSafeInteger(value[0]) &&
      Number.isSafeInteger(value[1]) &&
      value[0] >= 0 &&
      value[1] > value[0],
    "INVALID_ARGUMENT",
    "sourceRangeMs is invalid",
  );
  return Object.freeze([value[0], value[1]] as const);
}
function immutableJson<T>(value: T): T {
  if (Array.isArray(value))
    return Object.freeze(value.map((item) => immutableJson(item))) as T;
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableJson(item)]),
      ),
    ) as T;
  }
  return value;
}
export function createCanonicalScriptVersion(
  input: Omit<CanonicalScriptVersion, "contentHash" | "blocks"> & {
    blocks: readonly Omit<CanonicalLocalizationBlock, "blockHash">[];
  },
) {
  identity(input.id, "canonical.id");
  identity(input.workspaceId, "canonical.workspaceId");
  identity(input.projectId, "canonical.projectId");
  identity(input.projectVersionId, "canonical.projectVersionId");
  identity(input.approvedByClientId, "canonical.approvedByClientId");
  instant(input.approvedAt, "canonical.approvedAt");
  assertDomain(
    Number.isSafeInteger(input.revision) && input.revision >= 1,
    "INVALID_ARGUMENT",
    "canonical.revision is invalid",
  );
  assertDomain(
    input.blocks.length > 0 && input.blocks.length <= 500,
    "INVALID_ARGUMENT",
    "Canonical script requires 1-500 blocks",
  );
  const ids = new Set(input.blocks.map((x) => x.id));
  assertDomain(
    ids.size === input.blocks.length,
    "INVALID_ARGUMENT",
    "Canonical block IDs must be unique",
  );
  const blocks = input.blocks.map((raw) => {
    identity(raw.id, "block.id");
    identity(raw.sourceScriptBlockId, "block.sourceScriptBlockId");
    identity(raw.sourceAlignmentId, "block.sourceAlignmentId");
    assertDomain(
      ADAPTATION_LEVELS.includes(raw.adaptationLevel),
      "INVALID_ARGUMENT",
      "adaptationLevel is invalid",
    );
    assertDomain(
      raw.text.trim().length > 0,
      "INVALID_ARGUMENT",
      "Canonical block text is empty",
    );
    assertDomain(
      raw.dependencies.every((x) => ids.has(x) && x !== raw.id),
      "INVALID_ARGUMENT",
      "Canonical block dependency is invalid",
    );
    assertDomain(
      raw.claims.every(
        (x) =>
          x.id &&
          x.text.trim() &&
          (!x.protected || containsToken(raw.text, x.text)),
      ),
      "INVALID_ARGUMENT",
      "Protected claim must occur as a bounded value in canonical text",
    );
    const protectionIds = [
      ...raw.claims.map((x) => x.id),
      ...raw.qualifiers.map((x) => x.id),
      ...raw.protectedFacts.map((x) => x.id),
    ];
    assertDomain(
      new Set(protectionIds).size === protectionIds.length,
      "INVALID_ARGUMENT",
      "Protection semantic IDs must be unique",
    );
    const body = {
      ...raw,
      sourceLocale: canonicalLocale(raw.sourceLocale),
      text: raw.text.trim(),
      sourceRangeMs: validRange(raw.sourceRangeMs),
      claims: Object.freeze(raw.claims.map((x) => Object.freeze({ ...x }))),
      qualifiers: Object.freeze(
        raw.qualifiers.map((x) => Object.freeze({ ...x })),
      ),
      protectedFacts: Object.freeze(
        raw.protectedFacts.map((x) => Object.freeze({ ...x })),
      ),
      cta: raw.cta ? Object.freeze({ ...raw.cta }) : undefined,
      dependencies: Object.freeze([...raw.dependencies]),
    };
    return Object.freeze({ ...body, blockHash: calculateCanonicalHash(body) });
  });
  const body = {
    ...input,
    sourceLocale: canonicalLocale(input.sourceLocale),
    blocks: Object.freeze(blocks),
  };
  assertDomain(
    blocks.every((x) => x.sourceLocale === body.sourceLocale),
    "INVALID_ARGUMENT",
    "Block locale differs from canonical locale",
  );
  return Object.freeze({ ...body, contentHash: calculateCanonicalHash(body) });
}
function containsToken(text: string, value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const numeric = /\d/.test(value);
  return new RegExp(
    numeric
      ? `(^|[^\\p{L}\\p{N}.,+\\-])${escaped}($|[^\\p{L}\\p{N}.,])`
      : `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}
export type LocalizedBlockDraft = Readonly<{
  blockId: string;
  text: string;
  protectedValues: Readonly<Record<string, string>>;
  reviewStatus: "machine-translated" | "human-approved";
}>;
export function validateLocalizedBlocks(
  canonical: CanonicalScriptVersion,
  localized: readonly LocalizedBlockDraft[],
) {
  assertDomain(
    localized.length === canonical.blocks.length &&
      new Set(localized.map((x) => x.blockId)).size === localized.length,
    "INVALID_ARGUMENT",
    "Localized script must contain every block once",
  );
  const byId = new Map(localized.map((x) => [x.blockId, x]));
  for (const source of canonical.blocks) {
    const target = byId.get(source.id);
    assertDomain(
      Boolean(target?.text.trim()),
      "INVALID_ARGUMENT",
      `Localized block ${source.id} is missing`,
    );
    const protectedEntries = [
      ...source.protectedFacts,
      ...source.qualifiers,
      ...source.claims.filter((x) => x.protected),
    ];
    if (protectedEntries.length > 0) {
      assertDomain(
        target!.reviewStatus === "human-approved",
        "PRECONDITION_REQUIRED",
        `Protected semantics in block ${source.id} require human approval`,
      );
    }
    for (const entry of protectedEntries) {
      const approved = target!.protectedValues[entry.id];
      assertDomain(
        Boolean(approved) && containsToken(target!.text, approved!),
        "PRECONDITION_REQUIRED",
        `Protected semantic value ${entry.id} is missing in block ${source.id}`,
      );
    }
    if (source.cta)
      assertDomain(
        containsToken(target!.text, source.cta.destination),
        "PRECONDITION_REQUIRED",
        `CTA destination changed in block ${source.id}`,
      );
  }
  return Object.freeze(
    localized.map((x) =>
      Object.freeze({
        ...x,
        protectedValues: Object.freeze({ ...x.protectedValues }),
        text: x.text.trim(),
      }),
    ),
  );
}
export function validateMeasuredAlignment(
  words: readonly MeasuredWord[],
  durationMs: number,
) {
  assertDomain(
    Number.isSafeInteger(durationMs) && durationMs > 0,
    "INVALID_ARGUMENT",
    "Measured audio duration is invalid",
  );
  assertDomain(
    words.length > 0,
    "PRECONDITION_REQUIRED",
    "Measured word alignment is required",
  );
  let cursor = 0;
  for (const word of words) {
    assertDomain(
      word.word.trim().length > 0 &&
        (word.confidence === undefined ||
          (word.confidence >= 0 && word.confidence <= 1)) &&
        Number.isSafeInteger(word.startMs) &&
        Number.isSafeInteger(word.endMs) &&
        word.startMs >= cursor &&
        word.endMs > word.startMs &&
        word.endMs <= durationMs,
      "INVALID_ARGUMENT",
      "Measured alignment must be monotonic and within final audio",
    );
    cursor = word.endMs;
  }
  return Object.freeze(words.map((word) => Object.freeze({ ...word })));
}
export function resolveLocalizedAudioMode(input: {
  preferred: LocalizedAudioMode;
  allowedModes: readonly LocalizedAudioMode[];
  providerCapabilities: readonly LocalizedAudioMode[];
  localeSupported: boolean;
  voiceAuthorized: boolean;
  visualAuthorized: boolean;
  testimonial: boolean;
  disclosureRequired: boolean;
}) {
  const mode = input.preferred;
  assertDomain(
    LOCALIZED_AUDIO_MODES.includes(mode),
    "INVALID_ARGUMENT",
    "Localization mode is invalid",
  );
  const providerRequired = ![
    "uploaded",
    "local-voice",
    "subtitles-only",
  ].includes(mode);
  if (
    !input.allowedModes.includes(mode) ||
    !input.localeSupported ||
    (providerRequired && !input.providerCapabilities.includes(mode)) ||
    (["authorized-tts", "lip-sync", "regenerated-avatar"].includes(mode) &&
      !input.voiceAuthorized) ||
    (["lip-sync", "regenerated-avatar"].includes(mode) &&
      !input.visualAuthorized) ||
    (input.testimonial &&
      mode !== "subtitles-only" &&
      (!input.voiceAuthorized || !input.disclosureRequired))
  )
    throw new DomainError(
      "PRECONDITION_REQUIRED",
      "Requested localization mode is not authorized or available",
    );
  return Object.freeze({
    mode,
    disclosure:
      input.disclosureRequired && mode !== "subtitles-only"
        ? "Localized audio or synthetic visual media"
        : undefined,
  });
}
export function durationDeviation(
  canonical: CanonicalScriptVersion,
  localized: readonly { blockId: string; durationMs: number }[],
  threshold = 0.15,
) {
  assertDomain(
    Number.isFinite(threshold) && threshold > 0 && threshold < 1,
    "INVALID_ARGUMENT",
    "Duration threshold is invalid",
  );
  assertDomain(
    localized.length === canonical.blocks.length &&
      new Set(localized.map((x) => x.blockId)).size === localized.length &&
      localized.every((x) => canonical.blocks.some((b) => b.id === x.blockId)),
    "INVALID_ARGUMENT",
    "Measured durations must contain each canonical block exactly once",
  );
  const map = new Map(localized.map((x) => [x.blockId, x.durationMs]));
  const byBlock = canonical.blocks.map((block) => {
    const target = map.get(block.id);
    assertDomain(
      Number.isSafeInteger(target) && target! > 0,
      "PRECONDITION_REQUIRED",
      `Measured duration missing for ${block.id}`,
    );
    const ratio = target! / (block.sourceRangeMs[1] - block.sourceRangeMs[0]);
    return Object.freeze({
      blockId: block.id,
      ratio,
      requiresReflow:
        Math.abs(target! - (block.sourceRangeMs[1] - block.sourceRangeMs[0])) >
        (block.sourceRangeMs[1] - block.sourceRangeMs[0]) * threshold,
    });
  });
  const sourceTotal = canonical.blocks.reduce(
      (n, x) => n + x.sourceRangeMs[1] - x.sourceRangeMs[0],
      0,
    ),
    targetTotal = localized.reduce((n, x) => n + x.durationMs, 0);
  return Object.freeze({
    totalRatio: targetTotal / sourceTotal,
    byBlock: Object.freeze(byBlock),
    thresholdExceeded: byBlock.some((x) => x.requiresReflow),
  });
}
type VariantStagePatch = Pick<LocalizationVariant, "stage" | "updatedAt"> &
  Partial<
    Pick<
      LocalizationVariant,
      | "localizedAudioAssetId"
      | "alignment"
      | "localizedBlocks"
      | "translationProvenance"
      | "durationDeviation"
      | "dependentPlan"
      | "disclosure"
      | "approval"
      | "failure"
    >
  >;
export function transitionLocalizationVariant(
  current: LocalizationVariant,
  next: LocalizationStatus,
  patch: VariantStagePatch,
) {
  assertLocalizationVariantIntegrity(current);
  const allowedPatchKeys = new Set([
    "stage",
    "updatedAt",
    "localizedAudioAssetId",
    "alignment",
    "localizedBlocks",
    "translationProvenance",
    "durationDeviation",
    "dependentPlan",
    "disclosure",
    "approval",
    "failure",
  ]);
  assertDomain(
    Object.keys(patch).every((key) => allowedPatchKeys.has(key)),
    "INVALID_ARGUMENT",
    "Localization stage patch contains an immutable or unknown field",
  );
  instant(patch.updatedAt, "variant.updatedAt");
  assertDomain(
    TRANSITIONS[current.status].includes(next),
    "VERSION_CONFLICT",
    `Cannot transition localization from ${current.status} to ${next}`,
  );
  const safePatch = immutableJson({ ...patch });
  const alignment = safePatch.alignment ?? current.alignment,
    plan = safePatch.dependentPlan ?? current.dependentPlan,
    audio = safePatch.localizedAudioAssetId ?? current.localizedAudioAssetId;
  if (next === "approved")
    assertDomain(
      Boolean(
        alignment?.length &&
        audio &&
        plan &&
        (plan.captionIds.length ||
          plan.clipIds.length ||
          plan.brollIds.length ||
          plan.eventIds.length) &&
        safePatch.approval,
      ),
      "PRECONDITION_REQUIRED",
      "Approval requires final audio, measured alignment, non-empty recompiled plan, and approval",
    );
  const body = {
    ...current,
    ...safePatch,
    status: next,
    revision: current.revision + 1,
  };
  return Object.freeze({
    ...body,
    variantHash: calculateCanonicalHash({ ...body, variantHash: undefined }),
  });
}
export function markLocalizationStale(
  current: LocalizationVariant,
  newCanonical: CanonicalScriptVersion,
  updatedAt: string,
) {
  assertLocalizationVariantIntegrity(current);
  assertDomain(
    current.status !== "cancelled",
    "VERSION_CONFLICT",
    "Cancelled localization cannot become stale",
  );
  assertDomain(
    current.workspaceId === newCanonical.workspaceId &&
      current.projectId === newCanonical.projectId,
    "VERSION_CONFLICT",
    "Canonical version belongs to another localization authority boundary",
  );
  assertDomain(
    current.canonicalContentHash !== newCanonical.contentHash,
    "INVALID_ARGUMENT",
    "Canonical version is unchanged",
  );
  const body = {
    ...current,
    status: "stale" as const,
    stage: "canonical-stale",
    updatedAt,
    revision: current.revision + 1,
    failure: {
      code: "CANONICAL_VERSION_STALE",
      message: `Rebase required onto ${newCanonical.id}`,
      retryable: false,
    },
  };
  return Object.freeze({
    ...body,
    variantHash: calculateCanonicalHash({ ...body, variantHash: undefined }),
  });
}

export function rebaseLocalizationVariant(
  stale: LocalizationVariant,
  canonical: CanonicalScriptVersion,
  updatedAt: string,
) {
  assertDomain(
    stale.status === "stale",
    "VERSION_CONFLICT",
    "Only a stale localization can be rebased",
  );
  assertDomain(
    stale.workspaceId === canonical.workspaceId &&
      stale.projectId === canonical.projectId &&
      stale.canonicalContentHash !== canonical.contentHash,
    "VERSION_CONFLICT",
    "Rebase canonical does not belong to the variant authority boundary",
  );
  instant(updatedAt, "variant.updatedAt");
  const body: LocalizationVariant = {
    ...stale,
    canonicalScriptVersionId: canonical.id,
    canonicalContentHash: canonical.contentHash,
    status: "draft",
    stage: "rebased",
    revision: stale.revision + 1,
    localizedAudioAssetId: undefined,
    alignment: undefined,
    localizedBlocks: undefined,
    durationDeviation: undefined,
    dependentPlan: undefined,
    approval: undefined,
    failure: undefined,
    updatedAt,
    variantHash: "",
  };
  return Object.freeze({
    ...body,
    variantHash: calculateCanonicalHash({ ...body, variantHash: undefined }),
  });
}
