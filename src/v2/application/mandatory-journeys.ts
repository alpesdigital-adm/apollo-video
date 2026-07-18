export type JourneyEvidence={id:string;stages:{name:string;passed:boolean;evidence:string}[];policyViolations:string[];artifacts:string[];reconstructable:boolean};
export const MANDATORY_JOURNEY_STAGES={
  'J.001':['media-only-project','ingest-normalize-transcribe-perceive','treatment-story-edit-proxy-quality','annotation-patch-reconstructable-final'],
  'J.002':['script-6-3-3','three-grouped-recordings','take-alignment-compatibility-diverse-top-n','batch-scoped-cta-partial-retry'],
  'J.003':['validated-reel-rights','deconstruct-essential-hook-envelope','new-body-cta-no-irrelevant','non-causal-language'],
  'J.004':['evidence-index','compatible-proof-integrity-gate','contextual-proof-layout','expiry-revocation-recheck'],
  'J.005':['two-hour-hierarchy','partial-tier-search','contiguous-two-minute','contextual-multi-range-cost'],
  'J.006':['tts-and-uploaded-audio','block-avatar-critic-master','cached-block-with-broll','localized-affected-only'],
  'J.007':['unequal-capture-tracks','cascade-drift-gaps','manual-marker-requirement','podcast-teacher-react-direction'],
  'J.008':['approved-pt-to-en-es','locale-script-audio-timing-caption-assets','consent-mode-selection','localized-matrix-critic-mix'],
  'J.009':['least-scope-client','capability-schema-discovery','project-upload-workflow','operation-webhook','versioned-command-preflight','approve-render-export-lineage-api-only','ui-parity'],
} as const;
export function evaluateMandatoryJourney(evidence:JourneyEvidence){const expected=MANDATORY_JOURNEY_STAGES[evidence.id as keyof typeof MANDATORY_JOURNEY_STAGES];if(!expected)throw new Error('unknown-mandatory-journey');const missing=expected.filter(name=>!evidence.stages.some(stage=>stage.name===name&&stage.passed));return {passed:!missing.length&&!evidence.policyViolations.length&&evidence.artifacts.length>0&&evidence.reconstructable,missing,policyViolations:evidence.policyViolations,artifacts:evidence.artifacts};}
export function completeJourneyFixture(id:keyof typeof MANDATORY_JOURNEY_STAGES):JourneyEvidence{return {id,stages:MANDATORY_JOURNEY_STAGES[id].map(name=>({name,passed:true,evidence:`${id}:${name}`})),policyViolations:[],artifacts:[`${id}:quality-report`,`${id}:manifest`],reconstructable:true};}

export const RELEASE_CHECKS=['phase-tasks','fr-traceability','nfr-budgets','security-privacy','migration-recovery','dashboards-alerts-runbooks','unit-cost-limits','dataset-goldens','user-prerequisites-limitations-fallbacks','feature-flags-quotas-rollout','ui-api-mcp-parity','public-docs-catalogs','production-like-exit-demo','prd-spec-matrix-todo-current'] as const;
export type ReleaseEvidence={check:typeof RELEASE_CHECKS[number];passed:boolean;artifact:string;criticalFindings?:number};
export function evaluateReleaseGate(evidence:ReleaseEvidence[]){const missing=RELEASE_CHECKS.filter(check=>!evidence.some(item=>item.check===check&&item.passed&&item.artifact));const critical=evidence.filter(item=>(item.criticalFindings??0)>0).map(item=>item.check);return {passed:!missing.length&&!critical.length,missing,critical,report:Object.fromEntries(evidence.map(item=>[item.check,item.artifact]))};}
