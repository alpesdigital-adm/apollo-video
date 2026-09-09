import { calculateCanonicalHash } from "../domain/canonical-hash.ts";
import { assertDomain } from "../domain/errors.ts";
import {
  canonicalLocale,
  createCanonicalScriptVersion,
  LOCALIZED_AUDIO_MODES,
  markLocalizationStale,
  rebaseLocalizationVariant,
  transitionLocalizationVariant,
  validateLocalizedBlocks,
  type AdaptationLevel,
  type LocalizationStatus,
  type LocalizationVariant,
  type LocalizedAudioMode,
  type LocalizedBlockDraft,
} from "../domain/localization.ts";
import type { ApiAccessAuditContext } from "../domain/api-access-control.ts";
import type { LocalizationRepository } from "./ports/localization-repository.ts";

const nowIso = (clock: () => Date) => clock().toISOString();

export function createLocalizationProfileService(deps: {
  repository: LocalizationRepository;
  clock?: () => Date;
}) {
  return async (input: {
    id: string;
    workspaceId: string;
    targetLocale: string;
    market?: string;
    allowedModes: readonly LocalizedAudioMode[];
    actorClientId: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }) => {
    assertDomain(
      input.allowedModes.length > 0 &&
        new Set(input.allowedModes).size === input.allowedModes.length &&
        input.allowedModes.every((mode) =>
          LOCALIZED_AUDIO_MODES.includes(mode),
        ),
      "INVALID_ARGUMENT",
      "Localization profile requires unique supported modes",
    );
    const requestFingerprint = calculateCanonicalHash({
      ...input,
      id: undefined,
      idempotencyKey: undefined,
      authenticationAudit: undefined,
    });
    const replay = await deps.repository.findProfileReplay({
      workspaceId: input.workspaceId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return Object.freeze({ profile: replay, replayed: true });
    const profileBody = {
      id: input.id,
      workspaceId: input.workspaceId,
      targetLocale: canonicalLocale(input.targetLocale),
      ...(input.market ? { market: input.market.trim() } : {}),
      allowedModes: Object.freeze([...input.allowedModes]),
    };
    const profile = Object.freeze({
      ...profileBody,
      profileHash: calculateCanonicalHash(profileBody),
    });
    return deps.repository.insertProfile({
      profile,
      requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      actorClientId: input.actorClientId,
      authenticationAudit: input.authenticationAudit,
      createdAt: nowIso(deps.clock ?? (() => new Date())),
    });
  };
}

export function createCanonicalLocalizationService(deps: {
  repository: LocalizationRepository;
  clock?: () => Date;
}) {
  return async (input: {
    id: string;
    workspaceId: string;
    projectId: string;
    projectVersionId: string;
    alignmentId: string;
    expectedAlignmentHash: string;
    actorClientId: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
    protectionsByBlock?: Readonly<
      Record<
        string,
        Readonly<{
          claims?: readonly Readonly<{
            id: string;
            text: string;
            qualifier?: string;
            attribution?: string;
            protected: boolean;
          }>[];
          qualifiers?: readonly Readonly<{ id: string; text: string }>[];
          protectedFacts?: readonly Readonly<{ id: string; text: string }>[];
          dependencies?: readonly string[];
          cta?: Readonly<{ action: string; destination: string }>;
          adaptationLevel?: AdaptationLevel;
        }>
      >
    >;
  }) => {
    const requestFingerprint = calculateCanonicalHash({
      ...input,
      id: undefined,
      idempotencyKey: undefined,
      authenticationAudit: undefined,
    });
    const replay = await deps.repository.findCanonicalReplay({
      workspaceId: input.workspaceId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return Object.freeze({ canonical: replay, replayed: true });
    const context = await deps.repository.loadCanonicalContext(input);
    const run = context.alignment;
    assertDomain(
      run.status === "reviewed" && run.summary.reviewRequiredCount === 0,
      "PRECONDITION_REQUIRED",
      "Canonical localization requires an actually reviewed script alignment",
    );
    const sourceBlockIds = new Set(
      run.document.blocks.map((block) => block.id),
    );
    assertDomain(
      Object.keys(input.protectionsByBlock ?? {}).every((id) =>
        sourceBlockIds.has(id),
      ),
      "INVALID_ARGUMENT",
      "Canonical protection references an unknown reviewed script block",
    );
    const canonical = createCanonicalScriptVersion({
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: context.projectVersionId,
      sourceLocale: run.document.locale,
      revision: 1,
      approvedByClientId: input.actorClientId,
      approvedAt: nowIso(deps.clock ?? (() => new Date())),
      blocks: run.alignments.map((alignment) => {
        const source = run.document.blocks.find(
          (block) => block.id === alignment.blockId,
        )!;
        const protection = input.protectionsByBlock?.[source.id];
        assertDomain(
          Boolean(alignment.selectedCandidate),
          "PRECONDITION_REQUIRED",
          `Reviewed alignment block ${alignment.blockId} has no source range`,
        );
        return {
          id: `canonical-${source.id}`,
          sourceScriptBlockId: source.id,
          role: source.role,
          sourceLocale: run.document.locale,
          text: source.plannedText,
          sourceRangeMs: alignment.selectedCandidate!.sourceRangeMs,
          sourceAlignmentId: run.id,
          claims: protection?.claims ?? [],
          qualifiers: protection?.qualifiers ?? [],
          protectedFacts: protection?.protectedFacts ?? [],
          dependencies: protection?.dependencies ?? [],
          ...(protection?.cta ? { cta: protection.cta } : {}),
          adaptationLevel: protection?.adaptationLevel ?? "meaning-preserving",
        };
      }),
    });
    return deps.repository.insertCanonical({
      canonical,
      alignmentRunHash: input.expectedAlignmentHash,
      requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      authenticationAudit: input.authenticationAudit,
    });
  };
}

export function createLocalizationVariantService(deps: {
  repository: LocalizationRepository;
  clock?: () => Date;
}) {
  return async (input: {
    id: string;
    workspaceId: string;
    projectId: string;
    canonicalId: string;
    profileId: string;
    sourceArtifactId: string;
    expectedSourceSha256: string;
    preferredMode: LocalizedAudioMode;
    formats: readonly string[];
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
    const replay = await deps.repository.findVariantReplay({
      workspaceId: input.workspaceId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return Object.freeze({ variant: replay, replayed: true });
    const context = await deps.repository.loadVariantCreationContext(input);
    assertDomain(
      context.profile.allowedModes.includes(input.preferredMode) &&
        context.source.allowedModes.includes(input.preferredMode),
      "PRECONDITION_REQUIRED",
      "Localization mode is not allowed by current persisted profile and rights",
    );
    const at = nowIso(deps.clock ?? (() => new Date()));
    const body = {
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canonicalScriptVersionId: context.canonical.id,
      canonicalContentHash: context.canonical.contentHash,
      targetLocale: context.profile.targetLocale,
      ...(context.profile.market ? { market: context.profile.market } : {}),
      mode: input.preferredMode,
      formats: Object.freeze([...input.formats]),
      originalAudioAssetId: context.source.artifactId,
      status: "draft" as const,
      stage: "draft",
      revision: 1,
      createdByClientId: input.actorClientId,
      createdAt: at,
      updatedAt: at,
    };
    const variant = Object.freeze({
      ...body,
      variantHash: calculateCanonicalHash(body),
    });
    return deps.repository.insertVariant({
      variant,
      profileId: input.profileId,
      source: context.source,
      requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      authenticationAudit: input.authenticationAudit,
    });
  };
}

export function mutateLocalizationVariantService(deps: {
  repository: LocalizationRepository;
}) {
  return async (input: {
    workspaceId: string;
    projectId: string;
    variantId: string;
    expectedRevision: number;
    expectedHash: string;
    action: "advance" | "review" | "cancel" | "mark-stale" | "rebase";
    nextStatus?: LocalizationStatus;
    patch?: Parameters<typeof transitionLocalizationVariant>[2];
    canonicalId?: string;
    actorClientId: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }) => {
    const requestFingerprint = calculateCanonicalHash({
      ...input,
      idempotencyKey: undefined,
      authenticationAudit: undefined,
    });
    const replay = await deps.repository.findMutationReplay({
      workspaceId: input.workspaceId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return Object.freeze({ variant: replay, replayed: true });
    const current = await deps.repository.readVariant(input);
    assertDomain(
      Boolean(current),
      "LOCALIZATION_VARIANT_NOT_FOUND",
      "Localization variant was not found",
    );
    assertDomain(
      current!.revision === input.expectedRevision &&
        current!.variantHash === input.expectedHash,
      "VERSION_CONFLICT",
      "Localization variant changed before mutation",
    );
    let next: Readonly<LocalizationVariant>;
    if (input.action === "mark-stale" || input.action === "rebase") {
      assertDomain(
        Boolean(input.canonicalId),
        "INVALID_ARGUMENT",
        "Canonical version is required",
      );
      const canonical = await deps.repository.readCanonical({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canonicalId: input.canonicalId!,
      });
      assertDomain(
        Boolean(canonical),
        "LOCALIZATION_CANONICAL_NOT_FOUND",
        "Canonical localization version was not found",
      );
      next =
        input.action === "mark-stale"
          ? markLocalizationStale(current!, canonical!, input.patch!.updatedAt)
          : rebaseLocalizationVariant(
              current!,
              canonical!,
              input.patch!.updatedAt,
            );
    } else {
      const status = input.action === "cancel" ? "cancelled" : input.nextStatus;
      assertDomain(
        Boolean(status && input.patch),
        "INVALID_ARGUMENT",
        "Localization transition status and patch are required",
      );
      next = transitionLocalizationVariant(current!, status!, input.patch!);
    }
    return deps.repository.appendVariantRevision({
      previous: current!,
      next,
      action: input.action,
      requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      authenticationAudit: input.authenticationAudit,
    });
  };
}

export function reviewLocalizationTranslationService(deps: {
  repository: LocalizationRepository;
  clock?: () => Date;
}) {
  return async (input: {
    workspaceId: string;
    projectId: string;
    variantId: string;
    expectedRevision: number;
    expectedHash: string;
    localizedBlocks: readonly Readonly<
      Pick<LocalizedBlockDraft, "blockId" | "text" | "protectedValues">
    >[];
    actorClientId: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }) => {
    const requestFingerprint = calculateCanonicalHash({
      ...input,
      idempotencyKey: undefined,
      authenticationAudit: undefined,
    });
    const replay = await deps.repository.findMutationReplay({
      workspaceId: input.workspaceId,
      actorClientId: input.actorClientId,
      actorContextHash: input.authenticationAudit.contextHash,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
    });
    if (replay) return Object.freeze({ variant: replay, replayed: true });
    const current = await deps.repository.readVariant(input);
    assertDomain(
      Boolean(current),
      "LOCALIZATION_VARIANT_NOT_FOUND",
      "Localization variant was not found",
    );
    assertDomain(
      current!.revision === input.expectedRevision &&
        current!.variantHash === input.expectedHash,
      "VERSION_CONFLICT",
      "Localization variant changed before translation review",
    );
    const canonical = await deps.repository.readCanonical({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canonicalId: current!.canonicalScriptVersionId,
    });
    assertDomain(
      Boolean(canonical),
      "LOCALIZATION_CANONICAL_NOT_FOUND",
      "Canonical localization was not found",
    );
    const reviewed = validateLocalizedBlocks(
      canonical!,
      input.localizedBlocks.map((block) => ({
        ...block,
        reviewStatus: "human-approved" as const,
      })),
    );
    const next = transitionLocalizationVariant(current!, "audio", {
      stage: "translation-reviewed",
      updatedAt: nowIso(deps.clock ?? (() => new Date())),
      localizedBlocks: reviewed,
    });
    return deps.repository.appendVariantRevision({
      previous: current!,
      next,
      action: "review",
      requestFingerprint,
      idempotencyKey: input.idempotencyKey,
      authenticationAudit: input.authenticationAudit,
    });
  };
}
