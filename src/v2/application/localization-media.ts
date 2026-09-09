import { calculateCanonicalHash } from "../domain/canonical-hash.ts";
import { assertDomain } from "../domain/errors.ts";
import {
  approveLocalizationMediaRun,
  createLocalizationMediaRun,
  type LocalizationMediaSource,
} from "../domain/localization-media-run.ts";
import type { ApiAccessAuditContext } from "../domain/api-access-control.ts";
import type { LocalizationRepository } from "./ports/localization-repository.ts";
import type { LocalizationMediaRunRepository } from "./ports/localization-media-run-repository.ts";

export function requestLocalizationMediaService(deps: {
  variants: LocalizationRepository;
  runs: LocalizationMediaRunRepository;
  clock: () => Date;
}) {
  return async (input: {
    id: string;
    workspaceId: string;
    projectId: string;
    variantId: string;
    expectedRevision: number;
    expectedVariantHash: string;
    source: LocalizationMediaSource;
    actorClientId: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }) => {
    const requestFingerprint = calculateCanonicalHash({
      ...input,
      id: undefined,
      idempotencyKey: undefined,
      authenticationAudit: undefined,
    });
    const replay = await deps.runs.findReplay({
      workspaceId: input.workspaceId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return Object.freeze({ run: replay, replayed: true });
    const variant = await deps.variants.readVariant(input);
    assertDomain(
      Boolean(variant) &&
        variant!.revision === input.expectedRevision &&
        variant!.variantHash === input.expectedVariantHash,
      "VERSION_CONFLICT",
      "Localization variant changed before media request",
    );
    assertDomain(
      variant!.status === "audio" && variant!.stage === "translation-reviewed",
      "PRECONDITION_REQUIRED",
      "Localization media requires human-reviewed translation",
    );
    assertDomain(
      variant!.mode === "subtitles-only"
        ? input.source.kind === "original-audio" &&
            input.source.artifactId === variant!.originalAudioAssetId
        : ["local-voice", "uploaded"].includes(variant!.mode) &&
            input.source.kind === "uploaded-audio" &&
            input.source.artifactId !== variant!.originalAudioAssetId,
      "PRECONDITION_REQUIRED",
      "Media source is not authorized for this localization mode",
    );
    const run = createLocalizationMediaRun({
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      variantId: variant!.id,
      variantRevision: variant!.revision,
      variantHash: variant!.variantHash,
      canonicalContentHash: variant!.canonicalContentHash,
      source: input.source,
      requestedByClientId: input.actorClientId,
      at: deps.clock().toISOString(),
    });
    return deps.runs.create({
      run,
      requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      authenticationAudit: input.authenticationAudit,
    });
  };
}

export function approveLocalizationMediaService(deps: {
  runs: LocalizationMediaRunRepository;
  clock: () => Date;
}) {
  return async (input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    variantId: string;
    expectedRevision: number;
    expectedRunHash: string;
    actorClientId: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
    idempotencyKey: string;
    note?: string;
  }) => {
    const requestFingerprint = calculateCanonicalHash({
      ...input,
      idempotencyKey: undefined,
      authenticationAudit: undefined,
      note: input.note?.trim() || undefined,
    });
    const replay = await deps.runs.findApprovalReplay({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      variantId: input.variantId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return replay;
    const current = await deps.runs.read(input);
    assertDomain(
      Boolean(current) && current!.variantId === input.variantId &&
        current!.revision === input.expectedRevision &&
        current!.runHash === input.expectedRunHash,
      "VERSION_CONFLICT",
      "Localization media run changed before approval",
    );
    const approved = approveLocalizationMediaRun(current!, {
      clientId: input.actorClientId,
      at: deps.clock().toISOString(),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    });
    return deps.runs.approve({
      previousRunHash: current!.runHash,
      run: approved,
      authenticationAudit: input.authenticationAudit,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
  };
}

export function readLocalizationMediaService(deps: { runs: LocalizationMediaRunRepository }) {
  return async (input: { workspaceId: string; projectId: string; variantId: string; runId: string }) => {
    const run = await deps.runs.read(input);
    assertDomain(Boolean(run) && run!.variantId === input.variantId, "LOCALIZATION_VARIANT_NOT_FOUND", "Localization media run was not found");
    return Object.freeze({ run: run! });
  };
}
