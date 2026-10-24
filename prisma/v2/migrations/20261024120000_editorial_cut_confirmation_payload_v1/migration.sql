-- A removal Command that CONFIRMS a cut the Apollo proposed (apollo.projects.speech-removals.confirm, ADR-160) records who confirmed it and how in
-- payload.confirmation: { subject, medium } and, for a cut confirmed as passages, { passages, search } (the bounds that were cut, the bounds proposed,
-- whether the person moved them, and how the speech was searched). The seal constraint of the remove-spoken-content payload listed an exact set of keys
-- and so refused the Command that carries it: the same constraint, byte for byte, with the one optional key and its shape (the application validates the
-- rest; the Version origin verifier refuses a confirmation that is not exactly what the capability writes). A payload without the key is judged as before.
ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_output_payload_seal_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_output_payload_seal_check" CHECK (
  ("type" NOT IN ('create-output-variant', 'revise-output-spec') AND "outputPayloadJson" IS NULL AND "outputPayloadHash" IS NULL
    AND ("type" <> 'remove-spoken-content' OR ("payloadJson"::jsonb -> 'schemaVersion') IS DISTINCT FROM '3'::jsonb)) OR
  ("type" IN ('create-output-variant', 'revise-output-spec') AND "commandHash" IS NOT NULL AND "commandJson" IS NOT NULL
    AND "outputPayloadJson" IS NOT NULL AND "outputPayloadHash" IS NOT NULL AND "outputPayloadHash" ~ '^[a-f0-9]{64}$'
    AND "outputPayloadHash" = encode(sha256(convert_to("outputPayloadJson", 'UTF8')), 'hex')
    AND ("outputPayloadJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM 'output-canonical-json/v1'
    AND ("commandJson"::jsonb -> 'payload') IS NOT DISTINCT FROM "outputPayloadJson"::jsonb) OR
  COALESCE(("type" = 'remove-spoken-content' AND ("payloadJson"::jsonb -> 'schemaVersion') IS NOT DISTINCT FROM '3'::jsonb
    AND "commandHash" IS NOT NULL AND "commandJson" IS NOT NULL AND "commandHash" ~ '^[a-f0-9]{64}$'
    AND "commandHash" = w66_v2_sha("commandJson")
    AND "outputPayloadJson" IS NOT NULL AND "outputPayloadHash" IS NOT NULL AND "outputPayloadHash" ~ '^[a-f0-9]{64}$'
    AND "outputPayloadHash" = w66_v2_sha("outputPayloadJson")
    AND "outputPayloadJson"::jsonb IS NOT DISTINCT FROM "payloadJson"::jsonb
    AND ("commandJson"::jsonb -> 'payload') IS NOT DISTINCT FROM "outputPayloadJson"::jsonb
    AND w66_v2_exact_json("outputPayloadJson"::jsonb,ARRAY['schemaVersion','sourceTranscriptId','sourceArtifactId','variantId','rules','exclusions','sourceBinding','editPlanHash','audioProjection','impact'] ||
      CASE WHEN "outputPayloadJson"::jsonb ? 'exclusionOverrides' THEN ARRAY['exclusionOverrides'] ELSE ARRAY[]::text[] END ||
      CASE WHEN "outputPayloadJson"::jsonb ? 'confirmation' THEN ARRAY['confirmation'] ELSE ARRAY[]::text[] END)
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'rules') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'exclusions') IS NOT DISTINCT FROM 'array'
    AND (NOT ("outputPayloadJson"::jsonb ? 'exclusionOverrides') OR jsonb_typeof("outputPayloadJson"::jsonb -> 'exclusionOverrides') IS NOT DISTINCT FROM 'array')
    AND (NOT ("outputPayloadJson"::jsonb ? 'confirmation') OR (
      w66_v2_exact_json("outputPayloadJson"::jsonb -> 'confirmation',ARRAY['subject','medium'] ||
        CASE WHEN ("outputPayloadJson"::jsonb -> 'confirmation') ? 'passages' THEN ARRAY['passages','search'] ELSE ARRAY[]::text[] END)
      AND jsonb_typeof("outputPayloadJson"::jsonb #> '{confirmation,subject}') IS NOT DISTINCT FROM 'string'
      AND ("outputPayloadJson"::jsonb #>> '{confirmation,subject}') <> ''
      AND ("outputPayloadJson"::jsonb #>> '{confirmation,medium}') IN ('ui-session','api-key-scope')
      AND (NOT (("outputPayloadJson"::jsonb -> 'confirmation') ? 'passages') OR (
        jsonb_typeof("outputPayloadJson"::jsonb #> '{confirmation,passages}') IS NOT DISTINCT FROM 'array'
        AND jsonb_array_length("outputPayloadJson"::jsonb #> '{confirmation,passages}') > 0
        AND jsonb_typeof("outputPayloadJson"::jsonb #> '{confirmation,search}') IS NOT DISTINCT FROM 'object'))))
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'sourceBinding') IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'impact') IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'audioProjection') IN ('null','object')
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'sourceTranscriptId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'sourceArtifactId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'variantId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'editPlanHash') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb #> '{sourceBinding,bindingHash}') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb #> '{sourceBinding,document}') IS NOT DISTINCT FROM 'object'
    AND ("outputPayloadJson"::jsonb ->> 'sourceTranscriptId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    AND ("outputPayloadJson"::jsonb ->> 'sourceArtifactId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    AND ("outputPayloadJson"::jsonb ->> 'variantId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    AND ("outputPayloadJson"::jsonb ->> 'editPlanHash') ~ '^[a-f0-9]{64}$'
    AND ("outputPayloadJson"::jsonb #>> '{impact,schemaVersion}') IS NOT DISTINCT FROM 'editorial-cut-impact/v2'
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,schemaVersion}') IS NOT DISTINCT FROM 'editorial-source-binding/v1'
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,canonicalPolicyVersion}') IS NOT DISTINCT FROM 'output-canonical-json/v1'
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,projectId}') IS NOT DISTINCT FROM "projectId"
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,workspaceId}') IS NOT DISTINCT FROM "workspaceId"
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,parentVersionId}') IS NOT DISTINCT FROM "baseVersionId"
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,bindingHash}') IS NOT NULL
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,bindingHash}') = w66_v2_sha((("outputPayloadJson"::json -> 'sourceBinding') -> 'document')::text)
    AND "actorType" = 'api-client' AND "actorCredentialId" IS NOT NULL AND "actorEnvironment" IS NOT NULL
    AND "actorAuthenticationKind" IS NOT NULL AND "actorContextHash" IS NOT NULL
    AND "actorContextHash" = w66_v2_sha('{"authenticationKind":'||to_json("actorAuthenticationKind")::text||
      ',"clientId":'||to_json("actorId")::text||',"credentialId":'||to_json("actorCredentialId")::text||
      ',"delegatedIdentityId":'||coalesce(to_json("actorDelegatedIdentityId")::text,'null')||
      ',"delegatedUserId":'||coalesce(to_json("delegatedUserId")::text,'null')||
      ',"environment":'||to_json("actorEnvironment")::text||',"workspaceId":'||to_json("workspaceId")::text||
      ',"workspaceRole":'||coalesce(to_json("actorWorkspaceRole")::text,'null')||'}')
    AND "scopeJson"::jsonb IS NOT DISTINCT FROM '{"project":true}'::jsonb
    AND "commandJson"::jsonb IS NOT DISTINCT FROM (jsonb_build_object('schemaVersion',1,'id',"id",'workspaceId',"workspaceId",'projectId',"projectId",
      'baseVersionId',"baseVersionId",'baseHash',"baseHash",'type',"type",'scope',"scopeJson"::jsonb,'payload',"outputPayloadJson"::jsonb,
      'idempotencyKey',"idempotencyKey",'createdAt',w66_v2_iso("createdAt"),'author',jsonb_build_object('type',"actorType",'id',"actorId") ||
        CASE WHEN "delegatedUserId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('delegatedUserId',"delegatedUserId") END) ||
      CASE WHEN "reason" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason',"reason") END)),false)
);
