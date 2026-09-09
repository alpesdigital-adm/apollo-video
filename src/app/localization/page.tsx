"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import AppShellNavigation from "@/components/AppShellNavigation";
import LogoutButton from "@/components/LogoutButton";
import { APP_SHELL_DESTINATIONS } from "@/v2/domain/app-shell";
import {
  LOCALIZED_AUDIO_MODES,
  type LocalizedAudioMode,
} from "@/v2/domain/localization-contract";

type ApiEnvelope<T> = {
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
};
type Project = { id: string; name: string; locale?: string; status: string };
type ProtectedValue = { id: string; text: string };
type CanonicalBlock = {
  id: string;
  role: string;
  text: string;
  sourceRangeMs: [number, number];
  claims: Array<{
    id: string;
    text: string;
    qualifier?: string;
    protected: boolean;
  }>;
  qualifiers: ProtectedValue[];
  protectedFacts: ProtectedValue[];
  cta?: { action: string; destination: string };
  adaptationLevel: string;
};
type CanonicalVersion = {
  id: string;
  projectVersionId: string;
  sourceLocale: string;
  revision: number;
  blocks: CanonicalBlock[];
  approvedAt: string;
  contentHash: string;
};
type CanonicalCandidate = {
  alignmentId: string;
  alignmentHash: string;
  batchId: string;
  projectVersionId: string;
  sourceLocale: string;
  blocks: Array<{
    sourceScriptBlockId: string;
    role: string;
    text: string;
    sourceRangeMs: [number, number];
    reviewStatus: string;
  }>;
};
type CanonicalProtectionDraft = {
  claims: string;
  qualifiers: string;
  protectedFacts: string;
  adaptationLevel: "literal" | "meaning-preserving" | "market-adaptable";
  ctaAction: string;
  ctaDestination: string;
};
type AllowedMode = {
  mode: LocalizedAudioMode;
  allowed: boolean;
  reasons: string[];
};
type LocalizationProfile = {
  id: string;
  targetLocale: string;
  market?: string;
  allowedModes: LocalizedAudioMode[];
  profileHash: string;
};
type SourceMedia = {
  artifactId: string;
  originalFileName: string;
  sha256: string;
  status: string;
  rightsStatus?: string;
  role: string;
};
type Variant = {
  id: string;
  canonicalScriptVersionId: string;
  targetLocale: string;
  market?: string;
  mode: LocalizedAudioMode;
  formats: string[];
  originalAudioAssetId: string;
  localizedAudioAssetId?: string;
  status: string;
  stage: string;
  revision: number;
  variantHash: string;
  localizedBlocks?: Array<{
    blockId: string;
    text: string;
    durationMs?: number;
    protectedValues?: Record<string, string>;
  }>;
  allowedModes: AllowedMode[];
  alignment?: Array<{
    word: string;
    startMs: number;
    endMs: number;
    confidence: number;
  }>;
  durationDeviation?: {
    totalRatio: number;
    byBlock: Array<{ blockId: string; ratio: number; requiresReflow: boolean }>;
  };
  dependentPlan?: {
    captionIds: string[];
    clipIds: string[];
    brollIds: string[];
    eventIds: string[];
  };
  disclosure?: string;
  failure?: { code: string; message: string; retryable: boolean };
  operationId?: string;
  stale?: {
    isStale: boolean;
    latestCanonicalScriptVersionId?: string;
    reason?: string;
  };
};
type TranslationPreflight = {
  id: string;
  preflightHash: string;
  variantHash: string;
  providerId: string;
  model: string;
  inputCharacterCount: number;
  maximumOutputTokens: number;
  estimatedCostMicros: number;
  maximumCostMicros: number;
  currency: string;
  expiresAt: string;
};

const MODE_LABELS: Record<LocalizedAudioMode, string> = {
  "authorized-tts": "TTS autorizado",
  "local-voice": "Voz local",
  uploaded: "Áudio enviado",
  "lip-sync": "Lip-sync",
  "regenerated-avatar": "Avatar regenerado",
  "subtitles-only": "Som original + legendas",
};
const MODE_REQUIREMENTS: Partial<Record<LocalizedAudioMode, string>> = {
  "authorized-tts": "requer voz autorizada e provider configurado",
  "local-voice": "requer gravação local compatível",
  uploaded: "requer áudio localizado enviado",
  "lip-sync": "requer vídeo e provider compatíveis",
  "regenerated-avatar": "requer avatar e provider autorizados",
};
const STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho",
  translating: "Tradução",
  audio: "Áudio",
  visual: "Visual",
  review: "Revisão",
  approved: "Aprovada",
  failed: "Falhou",
  blocked: "Bloqueada",
  stale: "Desatualizada",
  cancelled: "Cancelada",
};

function apiMessage(payload: ApiEnvelope<unknown>, fallback: string) {
  return payload.error?.message ?? fallback;
}
function durationLabel(ms: number) {
  const seconds = Math.max(0, ms / 1000);
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
function deviationLabel(ratio?: number) {
  if (ratio === undefined) return "não medida";
  const value = (ratio - 1) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Sessão encerrada.");
  }
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.data)
    throw new Error(
      apiMessage(payload, "Não foi possível carregar a localização."),
    );
  return payload.data;
}

export default function LocalizationPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [canonicals, setCanonicals] = useState<CanonicalVersion[]>([]);
  const [candidates, setCandidates] = useState<CanonicalCandidate[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [canonicalDrafts, setCanonicalDrafts] = useState<
    Record<string, CanonicalProtectionDraft>
  >({});
  const [canonicalId, setCanonicalId] = useState("");
  const [variants, setVariants] = useState<Variant[]>([]);
  const [profiles, setProfiles] = useState<LocalizationProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [sources, setSources] = useState<SourceMedia[]>([]);
  const [sourceArtifactId, setSourceArtifactId] = useState("");
  const [newProfileLocale, setNewProfileLocale] = useState("en-US");
  const [newProfileMarket, setNewProfileMarket] = useState("US");
  const [newProfileModes, setNewProfileModes] = useState<LocalizedAudioMode[]>([
    "subtitles-only",
  ]);
  const [variantId, setVariantId] = useState("");
  const [requestedMode, setRequestedMode] =
    useState<LocalizedAudioMode>("subtitles-only");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewTexts, setReviewTexts] = useState<Record<string, string>>({});
  const [translationPreflight, setTranslationPreflight] = useState<{
    preflight: TranslationPreflight;
    commitToken: string;
  } | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const projectRequest = useRef(0);

  const canonical = useMemo(
    () => canonicals.find((item) => item.id === canonicalId) ?? canonicals[0],
    [canonicalId, canonicals],
  );
  const candidate = useMemo(
    () =>
      candidates.find(
        (item) =>
          `${item.alignmentId}:${item.projectVersionId}` === candidateId,
      ) ?? candidates[0],
    [candidateId, candidates],
  );
  const variant = useMemo(
    () => variants.find((item) => item.id === variantId) ?? variants[0],
    [variantId, variants],
  );
  const reviewCanonical = useMemo(
    () =>
      variant
        ? canonicals.find(
            (item) => item.id === variant.canonicalScriptVersionId,
          )
        : canonical,
    [canonical, canonicals, variant],
  );

  const loadProject = useCallback(
    async (selectedProjectId: string, quiet = false) => {
      if (!selectedProjectId) return;
      const request = ++projectRequest.current;
      if (!quiet) setNotice(null);
      try {
        const [
          canonicalData,
          candidateData,
          variantData,
          profileData,
          workspaceData,
        ] = await Promise.all([
          requestJson<{ versions: CanonicalVersion[] }>(
            `/v1/projects/${encodeURIComponent(selectedProjectId)}/canonical-script-versions`,
          ),
          requestJson<{ candidates: CanonicalCandidate[] }>(
            `/v1/projects/${encodeURIComponent(selectedProjectId)}/canonical-script-versions/candidates`,
          ),
          requestJson<{ variants: Variant[] }>(
            `/v1/projects/${encodeURIComponent(selectedProjectId)}/localization-variants`,
          ),
          requestJson<{ profiles: LocalizationProfile[] }>(
            "/v1/localization-profiles",
          ),
          requestJson<{ media: SourceMedia[] }>(
            `/v1/projects/${encodeURIComponent(selectedProjectId)}`,
          ),
        ]);
        if (
          request !== projectRequest.current ||
          selectedProjectId !== projectId
        )
          return;
        setCanonicals(canonicalData.versions);
        setCandidates(candidateData.candidates);
        setCandidateId((current) =>
          candidateData.candidates.some(
            (item) =>
              `${item.alignmentId}:${item.projectVersionId}` === current,
          )
            ? current
            : candidateData.candidates[0]
              ? `${candidateData.candidates[0].alignmentId}:${candidateData.candidates[0].projectVersionId}`
              : "",
        );
        setCanonicalId((current) =>
          canonicalData.versions.some((item) => item.id === current)
            ? current
            : (canonicalData.versions[0]?.id ?? ""),
        );
        setVariants(variantData.variants);
        setProfiles(profileData.profiles);
        setProfileId((current) =>
          profileData.profiles.some((item) => item.id === current)
            ? current
            : (profileData.profiles[0]?.id ?? ""),
        );
        const eligibleSources = workspaceData.media.filter(
          (item) =>
            item.status === "available" &&
            item.rightsStatus === "approved" &&
            ["source-master", "source-audio"].includes(item.role),
        );
        setSources(eligibleSources);
        setSourceArtifactId((current) =>
          eligibleSources.some((item) => item.artifactId === current)
            ? current
            : (eligibleSources[0]?.artifactId ?? ""),
        );
        setVariantId((current) =>
          variantData.variants.some((item) => item.id === current)
            ? current
            : (variantData.variants[0]?.id ?? ""),
        );
      } catch (error) {
        if (!quiet)
          setNotice(
            error instanceof Error
              ? error.message
              : "Não foi possível carregar a localização.",
          );
      }
    },
    [projectId],
  );

  useEffect(() => {
    void requestJson<{ projects: Project[] }>("/v1/projects?limit=100")
      .then(({ projects: rows }) => {
        setProjects(rows);
        setProjectId(rows[0]?.id ?? "");
      })
      .catch((error) =>
        setNotice(
          error instanceof Error
            ? error.message
            : "Não foi possível carregar projetos.",
        ),
      );
  }, []);
  useEffect(() => {
    setCanonicals([]);
    setCanonicalId("");
    setVariants([]);
    setVariantId("");
    setNotice(null);
    void loadProject(projectId);
  }, [loadProject, projectId]);
  useEffect(() => {
    if (
      !projectId ||
      !variants.some(
        (item) =>
          !["approved", "failed", "blocked", "cancelled", "stale"].includes(
            item.status,
          ),
      )
    )
      return;
    const handle = window.setInterval(
      () => void loadProject(projectId, true),
      5000,
    );
    return () => window.clearInterval(handle);
  }, [loadProject, projectId, variants]);
  useEffect(() => {
    setReviewTexts(
      Object.fromEntries(
        (variant?.localizedBlocks ?? []).map((block) => [
          block.blockId,
          block.text,
        ]),
      ),
    );
  }, [variant]);
  useEffect(() => {
    const allowed =
      profiles.find((item) => item.id === profileId)?.allowedModes ?? [];
    if (!allowed.includes(requestedMode) && allowed[0])
      setRequestedMode(allowed[0]);
  }, [profileId, profiles, requestedMode]);
  useEffect(() => {
    if (!candidate) {
      setCanonicalDrafts({});
      return;
    }
    setCanonicalDrafts((current) =>
      Object.fromEntries(
        candidate.blocks.map((block) => [
          block.sourceScriptBlockId,
          current[block.sourceScriptBlockId] ?? {
            claims: "",
            qualifiers: "",
            protectedFacts: "",
            adaptationLevel: "meaning-preserving",
            ctaAction: "",
            ctaDestination: "",
          },
        ]),
      ),
    );
  }, [candidate]);

  function lines(value: string) {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function createCanonical() {
    if (!projectId || !candidate) return;
    const protectionsByBlock = Object.fromEntries(
      candidate.blocks.map((block) => {
        const draft = canonicalDrafts[block.sourceScriptBlockId];
        const claims = lines(draft?.claims ?? "").map((text, index) => ({
          id: `${block.sourceScriptBlockId}-claim-${index + 1}`,
          text,
          protected: true,
        }));
        const qualifiers = lines(draft?.qualifiers ?? "").map(
          (text, index) => ({
            id: `${block.sourceScriptBlockId}-qualifier-${index + 1}`,
            text,
          }),
        );
        const protectedFacts = lines(draft?.protectedFacts ?? "").map(
          (text, index) => ({
            id: `${block.sourceScriptBlockId}-fact-${index + 1}`,
            text,
          }),
        );
        return [
          block.sourceScriptBlockId,
          {
            claims,
            qualifiers,
            protectedFacts,
            adaptationLevel: draft?.adaptationLevel ?? "meaning-preserving",
            ...(draft?.ctaAction.trim() && draft.ctaDestination.trim()
              ? {
                  cta: {
                    action: draft.ctaAction.trim(),
                    destination: draft.ctaDestination.trim(),
                  },
                }
              : {}),
          },
        ];
      }),
    );
    setBusy(true);
    setNotice(null);
    const intent = `canonical:${projectId}:${candidate.projectVersionId}:${candidate.alignmentId}:${candidate.alignmentHash}:${JSON.stringify(protectionsByBlock)}`;
    const key = actionKeys.current.get(intent) ?? crypto.randomUUID();
    actionKeys.current.set(intent, key);
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/canonical-script-versions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({
            projectVersionId: candidate.projectVersionId,
            alignmentId: candidate.alignmentId,
            expectedAlignmentHash: candidate.alignmentHash,
            protectionsByBlock,
          }),
        },
      );
      const payload = (await response.json()) as ApiEnvelope<{
        canonical: CanonicalVersion;
      }>;
      if (!response.ok || !payload.data)
        throw new Error(
          apiMessage(payload, "Não foi possível aprovar o roteiro canônico."),
        );
      actionKeys.current.delete(intent);
      await loadProject(projectId);
      setCanonicalId(payload.data.canonical.id);
      setNotice("Roteiro canônico aprovado e versionado.");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Não foi possível aprovar o roteiro canônico.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createVariant() {
    const profile = profiles.find((item) => item.id === profileId);
    const source = sources.find((item) => item.artifactId === sourceArtifactId);
    if (!projectId || !canonical || !profile || !source) return;
    setBusy(true);
    setNotice(null);
    const intent = `create:${projectId}:${canonical.id}:${profile.id}:${source.artifactId}:${source.sha256}:${requestedMode}`;
    const key = actionKeys.current.get(intent) ?? crypto.randomUUID();
    actionKeys.current.set(intent, key);
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/localization-variants`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({
            canonicalId: canonical.id,
            profileId: profile.id,
            sourceArtifactId: source.artifactId,
            expectedSourceSha256: source.sha256,
            preferredMode: requestedMode,
            formats: ["9:16", "16:9"],
          }),
        },
      );
      const payload = (await response.json()) as ApiEnvelope<{
        variant: Variant;
      }>;
      if (!response.ok || !payload.data)
        throw new Error(
          apiMessage(payload, "Não foi possível criar a variante."),
        );
      actionKeys.current.delete(intent);
      await loadProject(projectId);
      setVariantId(payload.data.variant.id);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Não foi possível criar a variante.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createProfile() {
    setBusy(true);
    setNotice(null);
    const intent = `profile:${newProfileLocale}:${newProfileMarket}:${newProfileModes.join(",")}`;
    const key = actionKeys.current.get(intent) ?? crypto.randomUUID();
    actionKeys.current.set(intent, key);
    try {
      const response = await fetch("/v1/localization-profiles", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          targetLocale: newProfileLocale,
          market: newProfileMarket.trim() || undefined,
          allowedModes: newProfileModes,
        }),
      });
      const payload = (await response.json()) as ApiEnvelope<{
        profile: LocalizationProfile;
      }>;
      if (!response.ok || !payload.data)
        throw new Error(
          apiMessage(payload, "Não foi possível criar o perfil."),
        );
      actionKeys.current.delete(intent);
      setProfileId(payload.data.profile.id);
      await loadProject(projectId);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Não foi possível criar o perfil.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function approveTranslation() {
    if (!projectId || !variant?.localizedBlocks) return;
    setBusy(true);
    setNotice(null);
    try {
      const localizedBlocks = variant.localizedBlocks.map((block) => ({
        blockId: block.blockId,
        text: reviewTexts[block.blockId] ?? block.text,
        protectedValues: block.protectedValues ?? {},
      }));
      const intent = `review:${variant.id}:${variant.revision}:${variant.variantHash}:${JSON.stringify(localizedBlocks)}`;
      const key = actionKeys.current.get(intent) ?? crypto.randomUUID();
      actionKeys.current.set(intent, key);
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/localization-variants/${encodeURIComponent(variant.id)}/translation-review`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({
            expectedRevision: variant.revision,
            expectedHash: variant.variantHash,
            localizedBlocks,
          }),
        },
      );
      const payload = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok)
        throw new Error(
          apiMessage(payload, "A revisão não pôde ser registrada."),
        );
      actionKeys.current.delete(intent);
      await loadProject(projectId);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "A revisão não pôde ser registrada.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function preflightTranslation() {
    if (!projectId || !variant) return;
    setBusy(true);
    setNotice(null);
    setTranslationPreflight(null);
    const intent = `translation-preflight:${variant.id}:${variant.revision}:${variant.variantHash}`;
    const key = actionKeys.current.get(intent) ?? crypto.randomUUID();
    actionKeys.current.set(intent, key);
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/localization-variants/${encodeURIComponent(variant.id)}/translation-preflight`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({
            expectedRevision: variant.revision,
            expectedHash: variant.variantHash,
          }),
        },
      );
      const payload = (await response.json()) as ApiEnvelope<{
        preflight: TranslationPreflight;
        commitToken: string;
      }>;
      if (!response.ok || !payload.data)
        throw new Error(
          apiMessage(payload, "Não foi possível calcular o custo da tradução."),
        );
      setTranslationPreflight(payload.data);
      actionKeys.current.delete(intent);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Não foi possível calcular o custo da tradução.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmTranslation() {
    if (!projectId || !variant || !translationPreflight) return;
    setBusy(true);
    setNotice(null);
    const intent = `translation-run:${translationPreflight.preflight.id}:${translationPreflight.preflight.preflightHash}`;
    const key = actionKeys.current.get(intent) ?? crypto.randomUUID();
    actionKeys.current.set(intent, key);
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/localization-variants/${encodeURIComponent(variant.id)}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({
            expectedRevision: variant.revision,
            expectedHash: variant.variantHash,
            preflightId: translationPreflight.preflight.id,
            expectedPreflightHash: translationPreflight.preflight.preflightHash,
            commitToken: translationPreflight.commitToken,
          }),
        },
      );
      const payload = (await response.json()) as ApiEnvelope<unknown>;
      if (!response.ok)
        throw new Error(
          apiMessage(payload, "A tradução não pôde ser enfileirada."),
        );
      actionKeys.current.delete(intent);
      setTranslationPreflight(null);
      setNotice("Tradução confirmada e enfileirada.");
      await loadProject(projectId);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "A tradução não pôde ser enfileirada.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#070707] text-[#f4f1ea]">
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0a0a0a] px-5 py-6 lg:flex">
          <div className="text-lg font-semibold tracking-[-0.03em]">
            Apollo <span className="text-[#d9aa3b]">Video</span>
          </div>
          <AppShellNavigation active="localization" />
          <div className="mt-auto">
            <LogoutButton />
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          <header className="border-b border-white/[0.07] px-5 py-5 sm:px-8">
            <div className="mx-auto flex max-w-[1500px] flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <h1 className="text-2xl font-semibold tracking-[-0.035em]">
                  Localização
                </h1>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-[#817d76]">
                  Adapte idioma, timing e áudio sem soltar os fatos aprovados do
                  original.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-[11px] text-[#9b968d]">
                  Projeto
                  <select
                    className="mt-1 block h-10 min-w-52 rounded-lg border border-white/[0.09] bg-[#0b0b0b] px-3 text-sm text-white"
                    onChange={(event) => setProjectId(event.target.value)}
                    value={projectId}
                  >
                    {projects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[11px] text-[#9b968d]">
                  Versão canônica
                  <select
                    className="mt-1 block h-10 min-w-52 rounded-lg border border-white/[0.09] bg-[#0b0b0b] px-3 text-sm text-white"
                    onChange={(event) => setCanonicalId(event.target.value)}
                    value={canonical?.id ?? ""}
                  >
                    {canonicals.map((item) => (
                      <option key={item.id} value={item.id}>
                        v{item.revision} · {item.sourceLocale}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <details className="mt-4 rounded-xl border border-white/[0.08] bg-[#0a0a0a] p-3 lg:hidden">
              <summary className="cursor-pointer text-xs font-medium text-[#bdb7ad]">
                Navegar pelo Apollo
              </summary>
              <nav
                aria-label="Navegação principal móvel"
                className="mt-3 grid grid-cols-2 gap-2"
              >
                {APP_SHELL_DESTINATIONS.map((item) =>
                  item.available ? (
                    <Link
                      aria-current={
                        item.id === "localization" ? "page" : undefined
                      }
                      className={`rounded-lg px-3 py-2 text-xs ${item.id === "localization" ? "bg-[#d8a93a]/10 text-[#e0ba59]" : "bg-white/[0.03] text-[#918c84]"}`}
                      href={item.href}
                      key={item.id}
                    >
                      {item.label}
                    </Link>
                  ) : null,
                )}
              </nav>
            </details>
          </header>
          <div className="mx-auto grid max-w-[1500px] gap-5 p-5 sm:p-8 xl:grid-cols-[300px_minmax(0,1fr)_360px]">
            <aside className="space-y-4">
              <details
                className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-4"
                data-testid="canonical-script-panel"
                open={canonicals.length === 0}
              >
                <summary className="cursor-pointer text-sm font-semibold">
                  Aprovar roteiro original
                </summary>
                <p className="mt-2 text-[11px] leading-5 text-[#817d76]">
                  Use somente um alinhamento já revisado. As proteções abaixo
                  acompanham cada bloco nas adaptações futuras.
                </p>
                <label className="mt-3 block text-[11px] text-[#918c84]">
                  Alinhamento revisado
                  <select
                    className="mt-1 h-10 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-3 text-sm text-white"
                    data-testid="canonical-candidate"
                    onChange={(event) => setCandidateId(event.target.value)}
                    value={
                      candidate
                        ? `${candidate.alignmentId}:${candidate.projectVersionId}`
                        : ""
                    }
                  >
                    {candidates.map((item) => (
                      <option
                        key={`${item.alignmentId}:${item.projectVersionId}`}
                        value={`${item.alignmentId}:${item.projectVersionId}`}
                      >
                        {item.sourceLocale} · {item.blocks.length} blocos ·{" "}
                        {item.batchId}
                      </option>
                    ))}
                  </select>
                </label>
                {candidate ? (
                  <div className="mt-3 space-y-3">
                    {candidate.blocks.map((block) => {
                      const draft = canonicalDrafts[block.sourceScriptBlockId];
                      const update = (
                        patch: Partial<CanonicalProtectionDraft>,
                      ) =>
                        setCanonicalDrafts((current) => ({
                          ...current,
                          [block.sourceScriptBlockId]: {
                            ...current[block.sourceScriptBlockId]!,
                            ...patch,
                          },
                        }));
                      return (
                        <fieldset
                          className="rounded-xl border border-white/[0.07] p-3"
                          data-testid={`canonical-block-${block.sourceScriptBlockId}`}
                          key={block.sourceScriptBlockId}
                        >
                          <legend className="px-1 text-[10px] text-[#c1bbb1]">
                            {block.role}
                          </legend>
                          <p className="text-xs leading-5 text-[#e1ddd5]">
                            {block.text}
                          </p>
                          <p className="mt-1 text-[9px] text-[#69655f]">
                            {durationLabel(block.sourceRangeMs[0])}–
                            {durationLabel(block.sourceRangeMs[1])} · revisão
                            humana
                          </p>
                          <label className="mt-3 block text-[10px] text-[#918c84]">
                            Regra de adaptação
                            <select
                              className="mt-1 h-9 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-white"
                              onChange={(event) =>
                                update({
                                  adaptationLevel: event.target
                                    .value as CanonicalProtectionDraft["adaptationLevel"],
                                })
                              }
                              value={
                                draft?.adaptationLevel ?? "meaning-preserving"
                              }
                            >
                              <option value="literal">Literal</option>
                              <option value="meaning-preserving">
                                Preservar sentido
                              </option>
                              <option value="market-adaptable">
                                Adaptável ao mercado
                              </option>
                            </select>
                          </label>
                          {(
                            ["claims", "qualifiers", "protectedFacts"] as const
                          ).map((field) => (
                            <label
                              className="mt-2 block text-[10px] text-[#918c84]"
                              key={field}
                            >
                              {field === "claims"
                                ? "Afirmações protegidas"
                                : field === "qualifiers"
                                  ? "Ressalvas obrigatórias"
                                  : "Fatos que não podem mudar"}
                              <textarea
                                className="mt-1 min-h-16 w-full resize-y rounded-lg border border-white/[0.09] bg-[#080808] px-2 py-2 text-xs leading-5 text-white"
                                onChange={(event) =>
                                  update({ [field]: event.target.value })
                                }
                                placeholder="Uma entrada por linha"
                                value={draft?.[field] ?? ""}
                              />
                            </label>
                          ))}
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <label className="text-[10px] text-[#918c84]">
                              Ação do CTA
                              <input
                                className="mt-1 h-9 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-white"
                                onChange={(event) =>
                                  update({ ctaAction: event.target.value })
                                }
                                placeholder="Ex.: Inscreva-se"
                                value={draft?.ctaAction ?? ""}
                              />
                            </label>
                            <label className="text-[10px] text-[#918c84]">
                              Destino do CTA
                              <input
                                className="mt-1 h-9 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-white"
                                onChange={(event) =>
                                  update({ ctaDestination: event.target.value })
                                }
                                placeholder="URL ou destino aprovado"
                                value={draft?.ctaDestination ?? ""}
                              />
                            </label>
                          </div>
                        </fieldset>
                      );
                    })}
                    <button
                      className="min-h-10 w-full rounded-lg bg-[#d8a93a] px-3 text-xs font-semibold text-black disabled:opacity-40"
                      data-testid="approve-canonical-script"
                      disabled={busy || candidate.blocks.length === 0}
                      onClick={() => void createCanonical()}
                      type="button"
                    >
                      Aprovar e criar versão canônica
                    </button>
                    <p className="text-[9px] leading-4 text-[#69655f]">
                      A aprovação usa a versão {candidate.projectVersionId} e o
                      hash do alinhamento exibido; se qualquer um mudar, o
                      servidor recusa.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg border border-dashed border-white/[0.09] p-3 text-[11px] leading-5 text-[#77736c]">
                    Nenhum alinhamento integralmente revisado está disponível
                    para este projeto.
                  </p>
                )}
              </details>
              <div className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-4">
                <h2 className="text-sm font-semibold">Nova variante</h2>
                <div className="mt-4 grid gap-3">
                  <div className="grid gap-2">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-[11px] text-[#918c84]">
                        Novo locale
                        <input
                          className="mt-1 h-10 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-3 text-sm text-white"
                          onChange={(event) =>
                            setNewProfileLocale(event.target.value)
                          }
                          placeholder="en-US"
                          value={newProfileLocale}
                        />
                      </label>
                      <label className="text-[11px] text-[#918c84]">
                        Mercado
                        <input
                          className="mt-1 h-10 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-3 text-sm text-white"
                          onChange={(event) =>
                            setNewProfileMarket(event.target.value)
                          }
                          placeholder="US"
                          value={newProfileMarket}
                        />
                      </label>
                    </div>
                    <fieldset className="rounded-lg border border-white/[0.07] p-2">
                      <legend className="px-1 text-[10px] text-[#918c84]">
                        Modos permitidos
                      </legend>
                      <div className="grid grid-cols-2 gap-2">
                        {LOCALIZED_AUDIO_MODES.map((mode) => (
                          <label
                            className="flex items-center gap-2 text-[10px] text-[#aaa49a]"
                            key={mode}
                          >
                            <input
                              checked={newProfileModes.includes(mode)}
                              onChange={(event) =>
                                setNewProfileModes((current) =>
                                  event.target.checked
                                    ? [...current, mode]
                                    : current.filter((item) => item !== mode),
                                )
                              }
                              type="checkbox"
                            />
                            <span>
                              {MODE_LABELS[mode]}
                              {MODE_REQUIREMENTS[mode] ? (
                                <small className="block text-[9px] text-[#77736c]">
                                  {MODE_REQUIREMENTS[mode]}
                                </small>
                              ) : null}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <button
                      className="h-10 rounded-lg border border-[#d8a93a]/40 px-3 text-xs text-[#ddb94f] disabled:opacity-40"
                      data-testid="create-localization-profile"
                      disabled={
                        busy ||
                        !newProfileLocale.trim() ||
                        newProfileModes.length === 0
                      }
                      onClick={() => void createProfile()}
                      type="button"
                    >
                      Criar perfil
                    </button>
                  </div>
                  <label className="text-[11px] text-[#918c84]">
                    Perfil de idioma e mercado
                    <select
                      className="mt-1 h-10 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-3 text-sm text-white"
                      onChange={(event) => setProfileId(event.target.value)}
                      value={profileId}
                    >
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.targetLocale}
                          {item.market ? ` · ${item.market}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] text-[#918c84]">
                    Fonte autorizada
                    <select
                      className="mt-1 h-10 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-3 text-sm text-white"
                      onChange={(event) =>
                        setSourceArtifactId(event.target.value)
                      }
                      value={sourceArtifactId}
                    >
                      {sources.map((item) => (
                        <option key={item.artifactId} value={item.artifactId}>
                          {item.originalFileName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] text-[#918c84]">
                    Modo solicitado
                    <select
                      className="mt-1 h-10 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-3 text-sm text-white"
                      onChange={(event) =>
                        setRequestedMode(
                          event.target.value as LocalizedAudioMode,
                        )
                      }
                      value={requestedMode}
                    >
                      {LOCALIZED_AUDIO_MODES.filter((mode) =>
                        profiles
                          .find((item) => item.id === profileId)
                          ?.allowedModes.includes(mode),
                      ).map((mode) => (
                        <option key={mode} value={mode}>
                          {MODE_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="mt-1 min-h-10 rounded-lg bg-[#d8a93a] px-3 text-xs font-semibold text-black disabled:opacity-40"
                    disabled={
                      busy || !canonical || !profileId || !sourceArtifactId
                    }
                    onClick={() => void createVariant()}
                    type="button"
                  >
                    Criar variante
                  </button>
                </div>
              </div>
              <div className="space-y-2" aria-label="Variantes do projeto">
                {variants.map((item) => (
                  <button
                    className={`w-full rounded-xl border p-3 text-left ${item.id === variant?.id ? "border-[#d8a93a]/40 bg-[#d8a93a]/[0.07]" : "border-white/[0.07] bg-[#0b0b0b]"}`}
                    key={item.id}
                    onClick={() => setVariantId(item.id)}
                    type="button"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">
                        {item.targetLocale}
                      </span>
                      <span className="text-[10px] text-[#aaa49a]">
                        {STATUS_LABELS[item.status] ?? item.status}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] text-[#716d66]">
                      {item.market ?? "Sem mercado"} · {item.stage}
                    </p>
                  </button>
                ))}
                {variants.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-white/[0.09] p-4 text-xs leading-5 text-[#77736c]">
                    Nenhuma variante neste projeto.
                  </p>
                ) : null}
              </div>
            </aside>
            <section className="min-w-0 rounded-2xl border border-white/[0.08] bg-[#0c0c0c]">
              <div className="border-b border-white/[0.07] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">
                      Original e adaptação
                    </h2>
                    <p className="mt-1 text-xs text-[#77736c]">
                      Claims, qualifiers e destinos protegidos aparecem junto do
                      texto.
                    </p>
                  </div>
                  {variant ? (
                    <span className="rounded-full border border-white/[0.09] px-3 py-1 text-[10px] text-[#aaa49a]">
                      {variant.stage}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="divide-y divide-white/[0.06]">
                {reviewCanonical?.blocks.map((block) => {
                  const localized = variant?.localizedBlocks?.find(
                    (item) => item.blockId === block.id,
                  );
                  const delta = variant?.durationDeviation?.byBlock.find(
                    (item) => item.blockId === block.id,
                  );
                  return (
                    <article
                      className="grid gap-4 p-5 md:grid-cols-2"
                      key={block.id}
                    >
                      <div>
                        <div className="flex justify-between text-[10px] text-[#77736c]">
                          <span>{block.role}</span>
                          <span>
                            {durationLabel(
                              block.sourceRangeMs[1] - block.sourceRangeMs[0],
                            )}
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-[#d4cfc6]">
                          {block.text}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {[
                            ...block.claims.map((item) => item.text),
                            ...block.qualifiers.map((item) => item.text),
                            ...block.protectedFacts.map((item) => item.text),
                            ...(block.cta ? [block.cta.destination] : []),
                          ].map((value) => (
                            <span
                              className="rounded-md border border-[#d5a638]/20 bg-[#d5a638]/[0.06] px-2 py-1 text-[9px] text-[#d7b75e]"
                              key={value}
                            >
                              {value}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-xl border border-white/[0.06] bg-[#090909] p-4">
                        <div className="flex justify-between text-[10px] text-[#77736c]">
                          <span>
                            {variant?.targetLocale ?? "Tradução pendente"}
                          </span>
                          <span
                            className={
                              delta?.requiresReflow
                                ? "text-[#d98787]"
                                : "text-[#78b98f]"
                            }
                          >
                            {deviationLabel(delta?.ratio)}
                          </span>
                        </div>
                        {variant?.stage ===
                          "awaiting-human-translation-review" && localized ? (
                          <textarea
                            aria-label={`Tradução de ${block.role}`}
                            className="mt-2 min-h-28 w-full rounded-lg border border-white/[0.09] bg-[#070707] p-3 text-sm leading-6 text-[#e7e2d9]"
                            onChange={(event) =>
                              setReviewTexts((current) => ({
                                ...current,
                                [localized.blockId]: event.target.value,
                              }))
                            }
                            value={
                              reviewTexts[localized.blockId] ?? localized.text
                            }
                          />
                        ) : (
                          <p className="mt-2 text-sm leading-6 text-[#e7e2d9]">
                            {localized?.text ?? "Aguardando adaptação."}
                          </p>
                        )}
                        {delta?.requiresReflow ? (
                          <p className="mt-3 text-[10px] leading-4 text-[#c98a8a]">
                            Requer replanejamento de imagem e pausas; o áudio
                            não será apenas esticado.
                          </p>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
                {!reviewCanonical ? (
                  <p className="p-8 text-center text-sm text-[#77736c]">
                    Escolha um projeto com roteiro canônico aprovado.
                  </p>
                ) : null}
              </div>
            </section>
            <aside className="space-y-4">
              {variant ? (
                <>
                  <div className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold">Áudio e timing</h2>
                      <span className="font-mono text-[10px] text-[#d6b359]">
                        {deviationLabel(variant.durationDeviation?.totalRatio)}
                      </span>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                      <AudioPlayer
                        label="Original"
                        artifactId={variant.originalAudioAssetId}
                      />
                      <AudioPlayer
                        label="Localizado"
                        artifactId={variant.localizedAudioAssetId}
                      />
                    </div>
                    <p className="mt-3 text-[10px] leading-4 text-[#77736c]">
                      {variant.alignment
                        ? `${variant.alignment.length} palavras realinhadas ao áudio final`
                        : "Alinhamento final ainda não disponível."}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-4">
                    <h2 className="text-sm font-semibold">Modos permitidos</h2>
                    <div className="mt-3 space-y-2">
                      {variant.allowedModes.map((item) => (
                        <div
                          className={`rounded-lg border p-3 ${item.allowed ? "border-[#5cab79]/20 bg-[#5cab79]/[0.05]" : "border-[#bb6464]/20 bg-[#bb6464]/[0.05]"}`}
                          key={item.mode}
                        >
                          <div className="flex justify-between text-xs">
                            <span>{MODE_LABELS[item.mode]}</span>
                            <span
                              className={
                                item.allowed
                                  ? "text-[#73bd8c]"
                                  : "text-[#d68080]"
                              }
                            >
                              {item.allowed ? "Permitido" : "Bloqueado"}
                            </span>
                          </div>
                          {item.reasons.length ? (
                            <p className="mt-1 text-[10px] leading-4 text-[#817d76]">
                              {item.reasons.join(" · ")}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                  {variant.disclosure ? (
                    <div className="rounded-xl border border-[#6587bb]/20 bg-[#6587bb]/[0.06] p-4 text-xs leading-5 text-[#91acd2]">
                      Disclosure: {variant.disclosure}
                    </div>
                  ) : null}
                  {variant.failure ? (
                    <div className="rounded-xl border border-[#bd6464]/25 bg-[#bd6464]/[0.06] p-4">
                      <p className="text-xs font-semibold text-[#df8b8b]">
                        {variant.failure.code}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[#ad8989]">
                        {variant.failure.message}
                      </p>
                    </div>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    {variant.status === "draft" ? (
                      <div className="col-span-2 rounded-lg border border-[#d8a93a]/20 bg-[#d8a93a]/[0.04] p-3">
                        <button
                          className="h-10 w-full rounded-lg bg-[#d8a93a] text-xs font-semibold text-black disabled:opacity-40"
                          data-testid="translation-preflight-required"
                          disabled={busy}
                          onClick={() => void preflightTranslation()}
                          type="button"
                        >
                          Calcular custo antes de traduzir
                        </button>
                        {translationPreflight ? (
                          <div
                            className="mt-3 rounded-lg border border-[#d8a93a]/25 p-3 text-[10px] leading-4 text-[#c7b27e]"
                            data-testid="translation-preflight-confirmation"
                          >
                            <p>
                              {translationPreflight.preflight.providerId} ·{" "}
                              {translationPreflight.preflight.model} ·{" "}
                              {
                                translationPreflight.preflight
                                  .inputCharacterCount
                              }{" "}
                              caracteres · até{" "}
                              {
                                translationPreflight.preflight
                                  .maximumOutputTokens
                              }{" "}
                              tokens de saída
                            </p>
                            <p>
                              Custo conservador reservado{" "}
                              {(
                                translationPreflight.preflight
                                  .estimatedCostMicros / 1_000_000
                              ).toFixed(6)}{" "}
                              {translationPreflight.preflight.currency};
                              política máxima{" "}
                              {(
                                translationPreflight.preflight
                                  .maximumCostMicros / 1_000_000
                              ).toFixed(6)}{" "}
                              {translationPreflight.preflight.currency}
                            </p>
                            <button
                              className="mt-2 h-9 w-full rounded-lg bg-[#d8a93a] font-semibold text-black disabled:opacity-40"
                              disabled={busy}
                              onClick={() => void confirmTranslation()}
                              type="button"
                            >
                              Confirmar custo e traduzir
                            </button>
                          </div>
                        ) : null}
                        <p className="mt-2 text-[10px] leading-4 text-[#8f887d]">
                          O envio fica bloqueado até o preflight apresentar
                          custo e emitir uma confirmação vinculada a esta
                          revisão e hash.
                        </p>
                      </div>
                    ) : null}
                    {variant.stage === "awaiting-human-translation-review" ? (
                      <button
                        className="col-span-2 h-10 rounded-lg bg-[#d8a93a] text-xs font-semibold text-black disabled:opacity-40"
                        disabled={busy || !variant.localizedBlocks?.length}
                        onClick={() => void approveTranslation()}
                        type="button"
                      >
                        Registrar revisão humana
                      </button>
                    ) : null}
                    {variant.status === "stale" ? (
                      <p className="col-span-2 text-[10px] leading-4 text-[#ddb94f]">
                        Esta variante precisa ser recriada a partir da versão
                        canônica atual.
                      </p>
                    ) : null}
                    {variant.status === "review" ? (
                      <p className="col-span-2 text-[10px] leading-4 text-[#77736c]">
                        A aprovação final fica indisponível até existir
                        evidência persistida do worker.
                      </p>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-dashed border-white/[0.09] p-5 text-xs leading-5 text-[#77736c]">
                  Selecione uma variante para revisar timing, modos e áudio.
                </div>
              )}
            </aside>
          </div>
          {notice ? (
            <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-[#bd6464]/30 bg-[#211010] px-4 py-3 text-xs text-[#e09a9a] shadow-2xl">
              {notice}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function AudioPlayer({
  label,
  artifactId,
}: Readonly<{ label: string; artifactId?: string }>) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] text-[#77736c]">{label}</p>
      {artifactId ? (
        <audio
          className="h-9 w-full"
          controls
          preload="metadata"
          src={`/v1/artifacts/${encodeURIComponent(artifactId)}/content`}
        />
      ) : (
        <div className="grid h-9 place-items-center rounded-lg border border-dashed border-white/[0.09] text-[9px] text-[#68645e]">
          Ainda não gerado
        </div>
      )}
    </div>
  );
}
