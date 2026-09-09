import { NextRequest, NextResponse } from "next/server";
import { requireScope } from "@/v2/application/authenticate-api-client";
import { readLocalizationMediaService } from "@/v2/application/localization-media";
import { PrismaLocalizationMediaRunRepository } from "@/v2/infrastructure/prisma/localization-media-run-repository";
import { authenticateExternalRequest } from "@/v2/public-api/authentication";
import {
  publicApiHeaders,
  resolveRequestId,
  respondPublicError,
} from "@/v2/public-api/errors";
import { presentSuccess } from "@/v2/public-api/presenters";

export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ projectId: string; variantId: string; runId: string }>;
  },
) {
  const requestId = resolveRequestId(request);
  try {
    const actor = await authenticateExternalRequest(request);
    requireScope(actor, "localization:read");
    const { projectId, variantId, runId } = await context.params;
    const result = await readLocalizationMediaService({
      runs: new PrismaLocalizationMediaRunRepository(),
    })({ workspaceId: actor.workspaceId, projectId, variantId, runId });
    return NextResponse.json(presentSuccess(result), {
      headers: publicApiHeaders(requestId),
    });
  } catch (error) {
    return respondPublicError(error, requestId);
  }
}
