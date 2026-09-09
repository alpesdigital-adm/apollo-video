import { NextRequest, NextResponse } from "next/server";
import {
  materializeActorAuditContext,
  requireScope,
} from "@/v2/application/authenticate-api-client";
import { approveLocalizationMediaService } from "@/v2/application/localization-media";
import { DomainError } from "@/v2/domain/errors";
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
  context: {
    params: Promise<{ projectId: string; variantId: string; runId: string }>;
  },
) {
  const requestId = resolveRequestId(request);
  try {
    const actor = await authenticateExternalRequest(request);
    requireScope(actor, "projects:approve");
    assertExternalMutationOrigin(request, actor);
    if (actor.authenticationKind !== "ui-session")
      throw new DomainError(
        "AUTH_SCOPE_REQUIRED",
        "Localization media approval requires an authenticated human session",
      );
    const { projectId, variantId, runId } = await context.params;
    const body = (await request.json().catch(() => {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Request body must be valid JSON",
      );
    })) as Record<string, unknown>;
    if (
      body.approved !== true ||
      !Number.isSafeInteger(body.expectedRunRevision) ||
      typeof body.expectedRunHash !== "string" ||
      (body.note !== undefined && typeof body.note !== "string")
    )
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Localization media approval body is invalid",
      );
    const repository = new PrismaLocalizationMediaRunRepository();
    const run = await approveLocalizationMediaService({
      runs: repository,
      clock: () => new Date(),
    })({
      workspaceId: actor.workspaceId,
      projectId,
      variantId,
      runId,
      expectedRevision: body.expectedRunRevision as number,
      expectedRunHash: body.expectedRunHash,
      actorClientId: actor.clientId,
      authenticationAudit: materializeActorAuditContext(actor),
      idempotencyKey: request.headers.get("idempotency-key")?.trim() ?? "",
      ...(typeof body.note === "string" ? { note: body.note } : {}),
    });
    return NextResponse.json(presentSuccess({ run }), {
      headers: publicApiHeaders(requestId),
    });
  } catch (error) {
    return respondPublicError(error, requestId);
  }
}
