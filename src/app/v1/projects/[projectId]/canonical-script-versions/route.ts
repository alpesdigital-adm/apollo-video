import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  materializeActorAuditContext,
  requireScope,
} from "@/v2/application/authenticate-api-client";
import { createLocalizationQueries } from "@/v2/application/localization-queries";
import { createCanonicalLocalizationService } from "@/v2/application/localization-persistence";
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
    const versions = await createLocalizationQueries(
      new PrismaLocalizationQueryRepository(),
    ).listCanonicals({ workspaceId: actor.workspaceId, projectId });
    return NextResponse.json(presentSuccess({ versions }), {
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
    if (actor.authenticationKind !== "ui-session")
      throw new DomainError(
        "AUTH_SCOPE_REQUIRED",
        "Canonical approval requires an authenticated human session",
      );
    const { projectId } = await context.params;
    const body = (await request.json().catch(() => {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Request body must be valid JSON",
      );
    })) as Record<string, unknown>;
    if (
      typeof body.projectVersionId !== "string" ||
      typeof body.alignmentId !== "string" ||
      typeof body.expectedAlignmentHash !== "string" ||
      (body.protectionsByBlock !== undefined &&
        (!body.protectionsByBlock ||
          typeof body.protectionsByBlock !== "object" ||
          Array.isArray(body.protectionsByBlock)))
    )
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Canonical localization body is invalid",
      );
    const result = await createCanonicalLocalizationService({
      repository: new PrismaLocalizationRepository(),
    })({
      id: `canonical-localization-${randomUUID()}`,
      workspaceId: actor.workspaceId,
      projectId,
      projectVersionId: body.projectVersionId,
      alignmentId: body.alignmentId,
      expectedAlignmentHash: body.expectedAlignmentHash,
      protectionsByBlock: body.protectionsByBlock as never,
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
