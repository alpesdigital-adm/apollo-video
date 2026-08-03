# ADR-008 — Render architecture and cache

Remotion owns deterministic timeline composition; FFmpeg owns probe, normalization, muxing and technical delivery. RenderInput contains exact plan, output, asset, tool and renderer hashes. Proxies, finals and range renders use distinct cache keys.

The target media toolchain is FFmpeg 8.1.1 and ffprobe 8.1.1, with Remotion 4.0.489. `config/platform-versions.json` is the machine-checked source for target versions; environment probes and goldens must still prove the binary actually executed because package version alone is not a codec guarantee.

Workers run with bounded CPU, memory and concurrency and no implicit database access from the renderer. Outputs are staged, verified and promoted atomically. A smoke fixture rebuilds the same manifest into a tolerance-checked artifact.
