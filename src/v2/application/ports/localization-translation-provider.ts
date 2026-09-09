import type {
  CanonicalScriptVersion,
  LocalizedBlockDraft,
} from "../../domain/localization.ts";

export interface LocalizationTranslationProvider {
  readonly providerId: string;
  readonly adapterVersion: string;
  readonly model: string;
  readonly configHash: string;
  readonly maxCompletionTokens: number;
  translate(
    input: Readonly<{
      canonical: Readonly<CanonicalScriptVersion>;
      targetLocale: string;
      market?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<readonly LocalizedBlockDraft[]>;
}
