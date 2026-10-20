# W63b — OCR and shot/motion against independent labels: pre-registration

Status: **frozen before any producer ran on any split**. This file, `scripts/validation/w63b-thresholds.mjs`,
`scripts/validation/w63b-metrics.mjs`, the corpus specification and generator, and the SHA-256 of both corpus manifests are
recorded in `docs/quality/w63b-freeze.json`, which is committed together with this file. The evaluator
(`scripts/validation/w63b-evaluate.mjs`) refuses to run when any of them differs from that record. Nothing below was chosen after
looking at a producer's output: before this commit the only things that ran were the label generator (it never calls a producer) and
unit tests of the pure comparison code on hand-built observations.

Plan text (`docs/PLANO-WAVES-61-70.md`, W63 "Provas"): independent goldens of talking head, audio without a face and inserted images,
plus small/multilingual text, hard cut, crossfade, motion and time after cuts; compare OCR and boundaries with external labels, testing
duplicates, gaps, reorder, adversarial source and PostgreSQL replay. Thresholds are acceptance criteria fixed before measurement and
published per stratum, including failures; calibration and evaluation never share a split; no case is selected after seeing output.

## What is evaluated, and what is not

W63b evaluates **the producers' measurements, as they reach the W63a server perception snapshot, against labels**. The producers are the
real ones, frozen: `TesseractOcrVideoAdapter` (sampled frames, `por`+`eng`) and `FfmpegTemporalVideoAnalyzer` (adjacent-pair change scores
and a global translation estimate on a 160x90 grid), run through admission, worker, sealed envelope and
`GET /perception/snapshot`'s service (`readServerPerceptionSnapshotService`) in a throwaway PostgreSQL started by the supervised harness.

W63b does **not** turn raw temporal scores into verified semantic labels. The shot/motion values stay `raw-adjacent-frame-change-score` /
`raw-global-translation-estimate`. To compare them with boundary labels the evaluation applies two fixed *evaluation rules* (B and C
below). They are rules of this evaluation, not product behaviour and not a classifier; a result against them says how well a consumer
applying that exact rule to the raw scores would have found the labelled boundaries. A failing stratum keeps its modality
`partial`/review in the product; no product threshold is changed to pass anything. Not evaluated: the face producer, speakers/diarization,
silence, objects, and real faces (see "Unrun").

## Corpus (independent label generator)

`scripts/validation/w63b-generate-corpus.mjs` builds every clip with FFmpeg (`lavfi color`, looped deterministic value-noise textures,
`crop`, `concat`, `xfade`, `overlay`, `drawtext`, `aevalsrc`) and writes the labels as data from its own parameters
(`w63b-corpus-spec.mjs`, `w63b-corpus-textures.mjs`). It never imports or runs a product producer. After rendering it checks each clip
against its OWN labels with separate code and aborts on a mismatch (cut and ramp frame positions, pan displacement by exact shift
matching on full-resolution frames, text ink present exactly on the labelled frames, insert appear/vanish, audio bursts, face-shape
position, frame count and CFR). All 33 development and 33 evaluation clips passed those checks.

- 1920x1080, 30 fps CFR, H.264 `crf 12`, `yuv420p`, single thread, bit-exact flags. Two independent generations of the development
  split produced byte-identical clips (33/33 SHA-256 equal; the manifest file itself differs only in a per-clip `renderSeconds` field,
  so a *manifest* hash is a record of one generation, a *clip* hash is reproducible).
- Font: Geist Regular, SIL Open Font License 1.1 (read from the font's own `name` table, nameID 13), taken from `next/dist/compiled/@vercel/og`;
  not committed. Cap height is calibrated by rendering `H` and recorded as measured (+-1 px). All media stay under
  `C:/Users/leand/Documents/Apollo/w61-70-20261008/w63b-*` (private, never committed).
- Splits: `development` is for debugging the harness/oracle only (producers are frozen and no parameter is tuned on it); `evaluation`
  was generated once with fixed seeds (`sha256("w63b/<split>/<clip id>")`) and disjoint text pools, and is sealed by its manifest hash.
- Conventions: source frames 0-based; a hard cut at frame `c` is the first frame of the new shot (the pair `c-1 -> c` carries it); pair `p`
  is frame `p -> p+1`; a crossfade `[a,b)` has frame `a` pure outgoing, pairs `a..b-1` carry the ramp, frame `b` pure incoming; motion labels
  are the content displacement in source pixels per frame (positive x: content moves right), which is what the analyzer's `translation()`
  reports (`current(x) = previous(x - dx)`); text/insert/face boxes are tight boxes measured from the generator's own render.
- Face-like shape: the private CC BY face corpus on this machine is admitted for a development benchmark that decodes and resizes to
  448x448 (`rights-admission-single-output-v2.json`, entries expired 2026-10-14T13:38Z); compositing a photograph into a clip is outside that
  scope, so the talking-head stratum uses a **drawn** face-like shape (ellipse, eyes, moving mouth, +-6 px sway) and is labelled
  `synthetic-face-like-shape`. It is a proxy for local motion under static background plus a lower-third, not a face evaluation.

### Strata, clips and sample sizes (evaluation split)

| stratum | clips | frames | labelled units | content |
| --- | --- | --- | --- | --- |
| `text-normal` | 3 | 540 | 72 line-samples | cap height 56 px, pt + en, dark / light / textured+box |
| `text-small-20` / `-16` / `-12` | 2 each | 360 each | 50 / 49 / 43 | cap height 20 / 16 / 12 px |
| `text-multilingual` | 3 | 540 | 76 | pt with diacritics, mixed pt/en, numerals; cap height 36 px |
| `static` | 1 | 120 | 119 pairs | textured, no motion |
| `hard-cut-high-contrast` | 2 | 381 | 6 cuts | black <-> white |
| `hard-cut-textured` | 2 | 357 | 6 cuts | independent textures |
| `crossfade-high-contrast` | 2 | 256 | 4 fades | flat <-> texture, 12-20 frames |
| `crossfade-low-contrast` | 1 | 130 | 2 fades | texture <-> texture (informational) |
| `pan-subquantum` | 1 | 120 | 1 segment | 4 px/frame (informational) |
| `pan-slow` | 2 | 240 | 2 segments | 12 px/frame, -x and +x |
| `pan-fast` | 2 | 240 | 2 segments | 36 px/frame, -x and +y |
| `inserted-image` | 2 | 300 | 4 inserts | 1280x720 and 480x270 overlays appearing/vanishing |
| `talking-head-synthetic` | 2 | 300 | 16 | drawn face + lower-third + audio bursts |
| `audio-no-face` | 1 | 150 | 18 | texture + text + audio bursts, no face |
| `time-after-cuts` | 2 | 480 | 22 + 2 cuts | a cut EditPlan whose timeline offsets differ from source; one with reordered source segments |
| `robustness-pts-gap` | 1 | 60 | - | PTS gap (non-CFR), expected to be refused |

The sizes are small. A stratum passing on 4-6 events is weak evidence and is reported with its N; a failure on that N is a finding.

### Unrun, with the reason

- `text-non-latin`: only `eng` and `por` traineddata exist locally and the product restricts OCR languages to `por`/`eng`
  (`createPerceptionProducerWorker`); nothing is generated for it.
- `talking-head-real-face` and `face-producer`: see above (rights scope; outside this wave's producers).

## Procedure

For each clip: seed a workspace/project whose head Version plays the clip (or, for `time-after-cuts`, a child Command whose EditPlan cuts
it); enqueue the OCR run (`sampleIntervalFrames = 15`) and the temporal run through the product's admission services; run each worker
once (`createPerceptionProducerWorker` / `createTemporalProducerWorker`, local artifact storage); read the snapshot with
`readServerPerceptionSnapshotService`; compare `result.observations` and `result.coverage` with the labels. A producer that fails on a
clip fails every criterion of that clip's strata (`producersSucceededOnEveryClip`).

### Text (OCR) comparison

For every sampled frame (taken from the snapshot's OCR coverage) and every label visible at that frame (through the label's own EditPlan
when the clip is cut), OCR words whose centre lies inside the label box grown by 1 % of the frame width and 30 % of the label height are
assigned to it; words are de-duplicated by confidence (a lower-confidence word overlapping a kept one by >= 50 % of the smaller area is
dropped; the producer keeps two readings from the two languages when their text differs, so this is needed); the reading is the kept
words left to right. Metrics per stratum: **exact match** (NFC, whitespace collapsed, case-sensitive, punctuation kept), **character error
rate** (Levenshtein over code points / label length, mean over units), **IoU share** (share of units whose union box has IoU >= 0.5 with
the label box; a miss counts as failing), **diacritic exact match** (labels containing a non-ASCII letter), **spurious words per sample**
(words outside every visible label box, including a label shown at a frame where it is not visible). Reported without a threshold: the
duplicate-reading rate and the median IoU.

### Boundary and motion comparison (raw scores, fixed rules)

- **Rule B (hard cut)**: a pair is flagged when its change score is >= 0.10 and >= 4 x the median of the (up to) 5 observed pairs on each
  side; adjacent flagged pairs are one event at the largest score. A labelled cut is detected when an event lies within +-1 pair of the cut
  pair. An event is *explained* when it lies within +-1 pair of a labelled cut, inside (+-1) a labelled crossfade, or within +-1 of an insert
  appear/vanish pair; any other event is a **false boundary**.
- **Rule C (crossfade)**: a pair is flagged when its score is >= max(0.006, 3 x the median of the observed pairs within +-24 pairs); a run
  is >= 3 consecutive flagged pairs; each labelled fade is scored by the IoU of its pair range with the best run. Rule C is applied only to
  clips without a moving segment (a run there counts as a false boundary unless it overlaps a labelled fade).
- **False boundaries per minute** = (false B events + false C runs) / minutes of observed pairs, pooled over the stratum.
- **Motion**: each labelled segment is compared pair by pair (boundary pairs excluded). Stationary segments: the share of observed pairs
  with |v| >= 2 px/s ("false motion"), the maximum |v| and the maximum residual. Moving segments (>= one grid quantum, 12 px/frame): the
  **direction share** (angle between the estimated vector and the label <= 45 degrees), the **relative error of the median magnitude** against
  the labelled magnitude (px/frame x 30), the **coverage** (observed / eligible pairs; pairs above the 0.35 gate are gaps) and the median
  residual. Below one grid quantum the estimator cannot resolve motion by construction (integer shifts of 12 source px on this grid), so
  `pan-subquantum` is informational.
- **Time after cuts**: every OCR observation must sit on the timeline frame the label EditPlan gives its source frame and the set of
  sampled frames must equal the expected set; the observed shot-pair set must equal the pairs inside the kept clips (so the seam pair is
  absent); the cut inside a kept clip must be found at its mapped pair; the cut that the edit removed is not expected.
- **Snapshot claims**: `image-insert` must remain `absent` (`INSERT_GEOMETRY_NOT_COMPILED`) with no observation of that kind: the product
  does not claim inserts, so the inserts are checked for *not being invented* and their edge scores are reported without a threshold.

## Acceptance criteria (all must hold; numbers are in `scripts/validation/w63b-thresholds.mjs`)

Where the numbers come from: the W63 preflight goldens (0.03 shot score, 2 px/s, 0.03 residual for a static textured frame; 0.20 residual
and the pan expectation; 0.80 for an abrupt black/white cut), the analyzer's own 0.35 reliability gate, the 12 px grid quantum, and
Tesseract's documented loss of accuracy below roughly 20 px capital height. They were not tuned on any output.

| stratum | criteria |
| --- | --- |
| `text-normal` | exact >= 0.90, mean CER <= 0.03, IoU share >= 0.90, spurious <= 0.25 / sample |
| `text-small-20` | exact >= 0.70, CER <= 0.10, IoU share >= 0.80, spurious <= 0.5 |
| `text-small-16` | exact >= 0.50, CER <= 0.20, IoU share >= 0.70, spurious <= 0.5 |
| `text-small-12` | exact >= 0.25, CER <= 0.40, spurious <= 1.0 (no IoU criterion) |
| `text-multilingual` | exact >= 0.85, CER <= 0.05, IoU share >= 0.90, diacritic exact >= 0.80, spurious <= 0.25 |
| `static` | max shot score < 0.03, max |v| < 2 px/s, max residual < 0.03, false boundaries 0 / min |
| `hard-cut-high-contrast` | recall 1.0 (+-1 pair), score at every cut >= 0.80, false boundaries <= 1 / min |
| `hard-cut-textured` | recall >= 0.90, false boundaries <= 1 / min, false-motion share <= 0.05 |
| `crossfade-high-contrast` | every fade matched with IoU >= 0.6 (recall 1.0), false boundaries <= 1 / min |
| `pan-slow`, `pan-fast` | direction share >= 0.90, magnitude relative error <= 0.25, coverage >= 0.90, median residual <= 0.20, lead-in false-motion share <= 0.05, false boundaries <= 1 / min |
| `inserted-image` | `image-insert` not claimed, false boundaries <= 1 / min, false-motion share <= 0.05 |
| `talking-head-synthetic` | lower-third exact >= 0.85, CER <= 0.05, IoU share >= 0.90, spurious <= 0.25; false-motion share <= 0.05; false boundaries <= 1 / min |
| `audio-no-face` | exact >= 0.90, CER <= 0.03, IoU share >= 0.90, spurious <= 0.25; false-motion share <= 0.05; false boundaries <= 1 / min |
| `time-after-cuts` | timeline frames exact, exact >= 0.85, mapped cut recall 1.0, seam pairs observed = 0, observed pair set exact, pan direction share >= 0.90, false boundaries <= 1 / min |
| `crossfade-low-contrast`, `pan-subquantum` | informational: measured and published, neither pass nor fail |

## Robustness cases (the W63a contract; run on `static-a`, `robustness-pts-gap-a` and a spare world)

1. **Duplicate envelope**: re-enqueueing with the same idempotency key returns the same operations, a second worker call claims nothing, there is
   exactly one envelope row per producer, and assembling the same envelope twice lists one `DUPLICATE_ENVELOPE` per repeated envelope and keeps the timeline hash.
2. **Gap**: an unexamined range stays unexamined: OCR `partial` with the exact complement, shot/motion `partial`, `image-insert`/`object`/
   `speaker`/`silence` `absent` with a reason, no kind `complete`.
3. **Reorder**: (a) a PTS-gap source is refused by both producers (operations failed, no envelope row, the snapshot lists no OCR/temporal input and
   says `NO_PRODUCER_RUN`); (b) the same evidence in reversed order assembles to the same snapshot hash; (c) `time-after-cuts-reordered-b` plays source segments out of order.
4. **Adversarial source**: an envelope row bound to other source bytes is refused at read with `PERSISTENCE_CONFLICT` and the unchanged rows read again; a source whose bytes differ from the
   declared SHA-256 is refused by both producers (operations failed, no envelope).
5. **Replay**: repeated reads and a fresh connection return the same snapshot hash and row.

## Reporting rules

Results are published per stratum with N, the metric values, each criterion's verdict and every failure, whether the stratum passes or fails.
A failing stratum is a finding about the producer (or, if it shows the oracle is wrong, an erratum — see below), never a reason to change a threshold.
The evaluation split may be run again only to repair the *harness* (a crash before results; never a metric, rule or threshold); every
attempt, with its harness run id and outcome, is listed in the published results. A change to a frozen file after this commit requires a dated erratum section appended
here, a new `w63b-freeze.json` and a statement of what had already been seen; results obtained before the erratum stay published.
