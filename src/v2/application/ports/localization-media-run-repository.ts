import type { ApiAccessAuditContext } from "../../domain/api-access-control.ts";
import type { LocalizationMediaRun } from "../../domain/localization-media-run.ts";

export interface LocalizationMediaRunRepository {
  readAuthenticationAudit(input: { workspaceId: string; runId: string }): Promise<Readonly<ApiAccessAuditContext>>;
  findReplay(input: {
    workspaceId: string;
    actorClientId: string;
    actorContextHash: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<Readonly<LocalizationMediaRun> | null>;
  create(input: {
    run: Readonly<LocalizationMediaRun>;
    requestFingerprint: string;
    idempotencyKey: string;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
  }): Promise<
    Readonly<{ run: Readonly<LocalizationMediaRun>; replayed: boolean }>
  >;
  read(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
  }): Promise<Readonly<LocalizationMediaRun> | null>;
  findApprovalReplay(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    variantId: string;
    actorClientId: string;
    actorContextHash: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<Readonly<LocalizationMediaRun> | null>;
  claim(input: {
    workerId: string;
    leaseTokenHash: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<Readonly<LocalizationMediaRun> | null>;
  heartbeat(input: {
    runId: string;
    workspaceId: string;
    runHash: string;
    leaseTokenHash: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  settle(input: {
    previousRunHash: string;
    run: Readonly<LocalizationMediaRun>;
    leaseTokenHash: string;
    settledAt: string;
  }): Promise<Readonly<LocalizationMediaRun>>;
  approve(input: {
    previousRunHash: string;
    run: Readonly<LocalizationMediaRun>;
    authenticationAudit: Readonly<ApiAccessAuditContext>;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<Readonly<LocalizationMediaRun>>;
}
