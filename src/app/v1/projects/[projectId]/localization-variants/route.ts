import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  materializeActorAuditContext,
  requireScope,
} from "@/v2/application/authenticate-api-client";
import { createLocalizationQueries } from "@/v2/application/localization-queries";
import { createLocalizationVariantService } from "@/v2/application/localization-persistence";
import { DomainError } from "@/v2/domain/errors";
import { PrismaLocalizationRepository } from "@/v2/infrastructure/prisma/localization-repository";
import { PrismaLocalizationQueryRepository } from "@/v2/infrastructure/prisma/localization-query-repository";
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
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request);
  try {
    const actor = await authenticateExternalRequest(request);
    requireScope(actor, "localization:read");
    const { projectId } = await context.params;
    const variants = await createLocalizationQueries(
      new PrismaLocalizationQueryRepository(),
    ).listVariants({ workspaceId: actor.workspaceId, projectId });
    return NextResponse.json(presentSuccess({ variants }), {
      headers: publicApiHeaders(requestId),
    });
  } catch (error) {
    return respondPublicError(error, requestId);
  }
}
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const requestId = resolveRequestId(request);
  try {
    const actor = await authenticateExternalRequest(request);
    requireScope(actor, "localization:run");
    assertExternalMutationOrigin(request, actor);
    const { projectId } = await context.params;
    const body = (await request.json().catch(() => {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Request body must be valid JSON",
      );
    })) as Record<string, unknown>;
    if (
      typeof body.canonicalId !== "string" ||
      typeof body.profileId !== "string" ||
      typeof body.sourceArtifactId !== "string" ||
      typeof body.expectedSourceSha256 !== "string" ||
      typeof body.preferredMode !== "string" ||
      !Array.isArray(body.formats) ||
      body.formats.some((format) => typeof format !== "string")
    )
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Localization variant body is invalid",
      );
    const result = await createLocalizationVariantService({
      repository: new PrismaLocalizationRepository(),
    })({
      id: `localization-variant-${randomUUID()}`,
      workspaceId: actor.workspaceId,
      projectId,
      canonicalId: body.canonicalId,
      profileId: body.profileId,
      sourceArtifactId: body.sourceArtifactId,
      expectedSourceSha256: body.expectedSourceSha256,
      preferredMode: body.preferredMode as never,
      formats: body.formats as string[],
      actorClientId: actor.clientId,
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      authenticationAudit: materializeActorAuditContext(actor),
    });
    return NextResponse.json(presentSuccess(result), {
      status: result.replayed ? 200 : 201,
      headers: publicApiHeaders(requestId),
    });
  } catch (error) {
    return respondPublicError(error, requestId);
  }
}
