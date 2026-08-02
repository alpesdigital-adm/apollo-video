CREATE TABLE "oidc_authorizations" (
    "stateHash" CHAR(64) NOT NULL,
    "browserBindingHash" CHAR(64) NOT NULL,
    "nonceHash" CHAR(64) NOT NULL,
    "protectedCodeVerifier" TEXT NOT NULL,
    "issuer" VARCHAR(512) NOT NULL,
    "clientId" VARCHAR(256) NOT NULL,
    "redirectUri" VARCHAR(2048) NOT NULL,
    "returnTo" VARCHAR(2048) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "oidc_authorizations_pkey" PRIMARY KEY ("stateHash")
);

CREATE INDEX "oidc_authorizations_expiresAt_idx" ON "oidc_authorizations"("expiresAt");
CREATE INDEX "oidc_authorizations_consumedAt_expiresAt_idx" ON "oidc_authorizations"("consumedAt", "expiresAt");

ALTER TABLE "oidc_authorizations"
    ADD CONSTRAINT "oidc_authorizations_hashes_check"
    CHECK (
        "stateHash" ~ '^[a-f0-9]{64}$' AND
        "browserBindingHash" ~ '^[a-f0-9]{64}$' AND
        "nonceHash" ~ '^[a-f0-9]{64}$'
    );
ALTER TABLE "oidc_authorizations"
    ADD CONSTRAINT "oidc_authorizations_lifetime_check"
    CHECK (
        "expiresAt" > "createdAt" AND
        "expiresAt" <= "createdAt" + INTERVAL '10 minutes' AND
        ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
    );
