# ADR-128 — Synthetic masters and provider boundary

Synthetic production is audio-first and split at stable sentence boundaries. Consent and rights are checked before provider cost or cache lookup. Provider adapters return normalized jobs, so ElevenLabs, HeyGen, fakes and future vendors never leak types into domain plans.

Approved raw video, final audio, alignment, configuration and lineage form an immutable synthetic master. Its complete-sentence segments can be reused without regeneration. Per-block cache and criticism isolate retries while the audio duration remains the timing authority.
