import { calculateCanonicalHash } from "./canonical-hash.ts";
import { assertDomain } from "./errors.ts";
import type { MeasuredWord } from "./localization.ts";

export const LOCALIZATION_MEDIA_RUN_SCHEMA_VERSION =
  "localization-media-run/v1" as const;
export type LocalizationMediaRunStatus =
  | "requested"
  | "processing"
  | "awaiting-human-approval"
  | "approved"
  | "failed"
  | "blocked"
  | "cancelled";
export type LocalizationMediaSource = Readonly<{
  kind: "original-audio" | "uploaded-audio";
  artifactId: string;
  artifactSha256: string;
  rightsSnapshotId: string;
}>;
export type LocalizationMediaEvidence = Readonly<{
  audioArtifactId: string;
  audioSha256: string;
  durationMs: number;
  alignmentArtifactId: string;
  alignmentSha256: string;
  words: readonly MeasuredWord[];
  blockDurations: readonly Readonly<{ blockId: string; durationMs: number }>[];
  durationDeviation: Readonly<{
    totalRatio: number;
    threshold: number;
    thresholdExceeded: boolean;
    byBlock: readonly Readonly<{
      blockId: string;
      ratio: number;
      requiresReflow: boolean;
    }>[];
  }>;
  renderablePlans: readonly Readonly<{
    format: string;
    snapshotId: string;
    planHash: string;
    proxyOperationId: string;
    proxyArtifactId: string;
  }>[];
  lineageHash: string;
}>;
export interface LocalizationMediaRun {
  schemaVersion: typeof LOCALIZATION_MEDIA_RUN_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  projectId: string;
  variantId: string;
  variantRevision: number;
  variantHash: string;
  canonicalContentHash: string;
  source: LocalizationMediaSource;
  status: LocalizationMediaRunStatus;
  revision: number;
  attempt: number;
  evidence?: LocalizationMediaEvidence;
  approval?: Readonly<{ clientId: string; at: string; note?: string }>;
  failure?: Readonly<{ code: string; message: string; retryable: boolean }>;
  requestedByClientId: string;
  createdAt: string;
  updatedAt: string;
  runHash: string;
}

function hashRun(
  body: Omit<LocalizationMediaRun, "runHash">,
): Readonly<LocalizationMediaRun> {
  return Object.freeze({ ...body, runHash: calculateCanonicalHash(body) });
}
function validHash(value: string) {
  return /^[a-f0-9]{64}$/.test(value);
}
function validInstant(value: string) {
  return (
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
  );
}

export function createLocalizationMediaRun(
  input: Omit<
    LocalizationMediaRun,
    | "schemaVersion"
    | "status"
    | "revision"
    | "attempt"
    | "createdAt"
    | "updatedAt"
    | "runHash"
  > & { at: string },
) {
  assertDomain(
    input.id.trim().length >= 3 &&
      input.variantRevision >= 1 &&
      validHash(input.variantHash) &&
      validHash(input.canonicalContentHash) &&
      validHash(input.source.artifactSha256) &&
      validInstant(input.at),
    "INVALID_ARGUMENT",
    "Localization media request is invalid",
  );
  return hashRun({
    ...input,
    schemaVersion: LOCALIZATION_MEDIA_RUN_SCHEMA_VERSION,
    status: "requested",
    revision: 1,
    attempt: 0,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

export function beginLocalizationMediaRun(
  run: Readonly<LocalizationMediaRun>,
  at: string,
) {
  assertDomain(
    run.status === "requested" ||
      (run.status === "failed" && run.failure?.retryable === true),
    "VERSION_CONFLICT",
    "Localization media run is not claimable",
  );
  assertDomain(
    validInstant(at),
    "INVALID_ARGUMENT",
    "Localization media run timestamp is invalid",
  );
  const { runHash: _hash, failure: _failure, ...current } = run;
  return hashRun({
    ...current,
    status: "processing",
    revision: run.revision + 1,
    attempt: run.attempt + 1,
    updatedAt: at,
  });
}

export function recordLocalizationMediaEvidence(
  run: Readonly<LocalizationMediaRun>,
  evidence: LocalizationMediaEvidence,
  at: string,
) {
  assertDomain(
    run.status === "processing" && validInstant(at),
    "VERSION_CONFLICT",
    "Only a processing localization media run can settle",
  );
  assertDomain(
    evidence.durationMs > 0 &&
      evidence.words.length > 0 &&
      evidence.blockDurations.length > 0 &&
      evidence.renderablePlans.length > 0 &&
      validHash(evidence.audioSha256) &&
      validHash(evidence.alignmentSha256) &&
      validHash(evidence.lineageHash),
    "PRECONDITION_REQUIRED",
    "Localization media evidence is incomplete",
  );
  assertDomain(
    evidence.renderablePlans.every((item) => validHash(item.planHash)),
    "PRECONDITION_REQUIRED",
    "Localization render evidence is invalid",
  );
  const { runHash: _hash, ...current } = run;
  return hashRun({
    ...current,
    status: "awaiting-human-approval",
    revision: run.revision + 1,
    evidence,
    updatedAt: at,
  });
}

export function approveLocalizationMediaRun(
  run: Readonly<LocalizationMediaRun>,
  approval: Readonly<{ clientId: string; at: string; note?: string }>,
) {
  assertDomain(
    run.status === "awaiting-human-approval" &&
      Boolean(run.evidence) &&
      validInstant(approval.at),
    "PRECONDITION_REQUIRED",
    "Only measured rendered localization media can be approved",
  );
  const { runHash: _hash, ...current } = run;
  return hashRun({
    ...current,
    status: "approved",
    revision: run.revision + 1,
    approval: Object.freeze({ ...approval }),
    updatedAt: approval.at,
  });
}

export function failLocalizationMediaRun(
  run: Readonly<LocalizationMediaRun>,
  status: "failed" | "blocked",
  failure: Readonly<{ code: string; message: string; retryable: boolean }>,
  at: string,
) {
  assertDomain(
    run.status === "processing",
    "VERSION_CONFLICT",
    "Only a processing localization media run can fail",
  );
  const { runHash: _hash, ...current } = run;
  return hashRun({
    ...current,
    status,
    revision: run.revision + 1,
    failure: Object.freeze({ ...failure }),
    updatedAt: at,
  });
}
