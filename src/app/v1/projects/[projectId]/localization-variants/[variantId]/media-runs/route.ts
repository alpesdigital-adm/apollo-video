import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  materializeActorAuditContext,
  requireScope,
} from "@/v2/application/authenticate-api-client";
import { requestLocalizationMediaService } from "@/v2/application/localization-media";
import { DomainError } from "@/v2/domain/errors";
import { PrismaLocalizationRepository } from "@/v2/infrastructure/prisma/localization-repository";
import { PrismaLocalizationMediaRunRepository } from "@/v2/infrastructure/prisma/localization-media-run-repository";
import {
  assertExternalMutationOrigin,
  authenticateExternalRequest,
} from "@/v2/public-api/authentication";
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from "@/v2/public-api/errors";
import { presentSuccess } from "@/v2/public-api/presenters";

export const dynamic = "force-dynamic";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string; variantId: string }> },
) {
  const requestId = resolveRequestId(request);
  try {
    const actor = await authenticateExternalRequest(request);
    requireScope(actor, "localization:run");
    assertExternalMutationOrigin(request, actor);
    const { projectId, variantId } = await context.params;
    const body = (await request.json().catch(() => {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Request body must be valid JSON",
      );
    })) as Record<string, unknown>;
    const source = body.source as Record<string, unknown> | undefined;
    if (
      !Number.isSafeInteger(body.expectedRevision) ||
      typeof body.expectedVariantHash !== "string" ||
      !source ||
      !["original-audio", "uploaded-audio"].includes(String(source.kind)) ||
      typeof source.artifactId !== "string" ||
      typeof source.artifactSha256 !== "string" ||
      typeof source.rightsSnapshotId !== "string"
    )
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Localization media request body is invalid",
      );
    const result = await requestLocalizationMediaService({
      variants: new PrismaLocalizationRepository(),
      runs: new PrismaLocalizationMediaRunRepository(),
      clock: () => new Date(),
    })({
      id: `localization-media-${randomUUID()}`,
      workspaceId: actor.workspaceId,
      projectId,
      variantId,
      expectedRevision: body.expectedRevision as number,
      expectedVariantHash: body.expectedVariantHash,
      source: source as never,
      actorClientId: actor.clientId,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      authenticationAudit: materializeActorAuditContext(actor),
    });
    return NextResponse.json(presentSuccess(result), {
      status: result.replayed ? 200 : 202,
      headers: publicApiHeaders(requestId),
    });
  } catch (error) {
    return respondPublicError(error, requestId);
  }
}
