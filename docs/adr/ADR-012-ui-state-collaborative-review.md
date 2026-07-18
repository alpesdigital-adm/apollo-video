# ADR-012 — UI state and collaborative review

Server versions are authoritative; timeline gestures remain transient until submitted as Commands with base-version preconditions. Optimistic updates reconcile on event delivery and reconnect resumes from a stable cursor.

The first collaboration scope uses explicit review annotations and version conflicts, not free-form simultaneous timeline mutation. Annotation → ImpactPreview → confirmed PatchSet → new ProjectVersion is the only mutation path. Overlapping targets require user resolution; non-overlapping commands may safely rebase.
