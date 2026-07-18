# ADR-009 — Perception pipeline and metadata tiers

Probe and transcript are the minimum tier; diarization, visual observations, chapters and semantic moments are progressively computed. Every field records whether it is observed, inferred, human or derived plus model/tool version and confidence.

Long media is processed hierarchically and partially searchable. Model changes invalidate only dependent tiers. Promotion thresholds and eval sets are versioned; low-confidence metadata triggers review instead of becoming fact.
