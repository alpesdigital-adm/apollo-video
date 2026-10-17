# W63 temporal analyzer preflight — controlled golden protocol

Frozen before the isolated adapter's first measurement. This is an engineering
smoke protocol, not external evaluation or acceptance of W63.

## Scope and bounds

- Decode the actual source bytes with configured FFmpeg/FFprobe SHA-256 pins,
  verify each binary against its expected digest before execution and again
  after execution, and verify the source SHA-256, observed frame PTS and zero display rotation
  before and after analysis. Support only a single CFR video stream with at most
  300 frames, 10 seconds, 1920×1080 source and a 160×90 grayscale analysis grid.
  Reject VFR, missing/reordered PTS, rotation and excess work explicitly. Set
  decoder/filter thread limits to two and an aggregate 120-second deadline.
- Return raw adjacent-frame shot change scores and global translation estimates
  in source pixels/second, plus residual luma error and ambiguity. These are
  **measurements**, not verified hard-cut, camera/object or ROI labels.
- The assessed domain is exactly [first observed frame PTS, last observed frame
  PTS]. It does not claim the last frame's following duration or whole-video
  coverage. Keep shot and motion coverage/gaps separate. A frame pair with change score
  above 0.35 is not suitable for translation and becomes a motion gap with
  reason `UNRELIABLE_FRAME_DIFFERENCE`. Missing bytes/PTS fail the run rather
  than becoming invented coverage. The adapter does not publish an envelope.
- Each child process has an abort signal and deadline; its scratch files belong
  to the caller and are removed in `finally`. No output is trusted after abort.

## Predeclared controlled goldens

All clips are generated from known graphics before analysis with 30 fps and
observed PTS. Labels come from the generator, independently of adapter output.
Thresholds apply only to these controlled examples:

| Case | Expected check |
| --- | --- |
| Static textured frame | maximum shot change <0.03; maximum vector magnitude <2 source px/s; residual <0.03 |
| Constant horizontal pan | median vector magnitude >10 source px/s across intact pairs; finite residual <0.20 |
| Abrupt black/white cut | transition score >0.80; no hard-cut classification claimed; motion pair is a gap |
| Reordered or non-CFR PTS | reject without a result |
| Abort during decode | terminate child work and publish no result |

The decoder grid and compression can affect these numbers. A failed golden is
reported as failure; thresholds are not tuned after inspecting its result.
These goldens do not cover crossfades, natural scene cuts, object motion,
camera shake, occlusion, blur, different codecs or the Imersão master. Before
claiming shot boundaries or motion semantics, freeze independent labels and
strata, compare scores/errors by source PTS and publish false-positive and
false-negative rates on held-out media. API, PostgreSQL, timeline aggregation,
Director consumption, final MP4 critic and human review remain pending.
