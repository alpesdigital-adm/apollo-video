# ADR-008 — Render architecture and cache

Remotion owns deterministic timeline composition; FFmpeg owns probe, normalization, muxing and technical delivery. RenderInput contains exact plan, output, asset, tool and renderer hashes. Proxies, finals and range renders use distinct cache keys.

Workers run with bounded CPU, memory and concurrency and no implicit database access from the renderer. Outputs are staged, verified and promoted atomically. A smoke fixture rebuilds the same manifest into a tolerance-checked artifact.
