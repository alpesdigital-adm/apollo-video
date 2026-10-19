# W63b — OCR and shot/motion against independent labels: results

Evaluation of the frozen W63a producers (Tesseract OCR adapter, FFmpeg temporal analyzer) through the product path against the labels of
`docs/quality/w63b-perception-label-eval-prereg.md`. Status: **measured on a controlled synthetic corpus, local only**. It is not an
acceptance of W63, does not mark a `TODO.md` box and does not touch `docs/quality/project-status.json`.

Numbers are in `docs/quality/w63b-evaluation-results.json` (full per-clip observations stay private under
`C:/Users/leand/Documents/Apollo/w61-70-20261008/w63b-results-evaluation-run1`).

## Identity of the run

| | |
| --- | --- |
| freeze commit (pre-registration, thresholds, both manifest hashes) | `942066853fb56a2e53afa1a398743d4603642afe` |
| head when the evaluation ran | `6f300e090216cb668305f06aa9448e0e33e9ef68` (the runner was not frozen; no frozen file changed after the freeze) |
| evaluation corpus manifest SHA-256 | `5eec7cf55412728fe088188efbc9f2bf509d2073b457fdf861453dfc94c41a10` (33 clips, generated once) |
| development corpus manifest SHA-256 | `8d33baca02f4ce4d8ae63ffcfc27b10512dc0c0ecf5b840ac85d1bdcfdfe3cd7` |
| evaluation attempts | one: harness run `w63b-eval1-18515a95` (success, post-flight clean: cluster stopped, zero backends). It was not repeated. |
| development runs (harness/oracle debugging only) | `w63b-devsmoke1-824c9e7c` (4 clips + robustness), `w63b-devfull1-7938bd80` (33 clips + robustness). Between them only `w63b-evaluate.mjs` changed (freeze-check scope; the evidence-order robustness case, because the evidence reader uses the latest envelope per version). No metric, rule or threshold changed. |
| tools | FFmpeg 6.1.1 (ffmpeg-static, sha256 `04e13079...94ad00`), system FFprobe 8.1.1, Tesseract 5.5.3 (`c66f0f12...f420`), `por`+`eng` traineddata, Node 24.10.0 |

## Verdicts per stratum (evaluation split)

N counts the labelled units the criterion is computed on. Small N is stated; a pass on 4-6 events is weak evidence.

| stratum | verdict | N | criterion values (threshold) |
| --- | --- | --- | --- |
| `text-normal` | **FAIL** | 72 line-samples, 36 samples | exact 0.806 (>= 0.90), CER 0.0716 (<= 0.03), IoU share 0.889 (>= 0.90), spurious 2.67 / sample (<= 0.25) |
| `text-small-20` | pass | 50 | exact 1.000 (>= 0.70), CER 0 (<= 0.10), IoU share 1.0 (>= 0.80), spurious 0 (<= 0.5) |
| `text-small-16` | pass | 49 | exact 0.837 (>= 0.50), CER 0.0113 (<= 0.20), IoU share 1.0 (>= 0.70), spurious 0 (<= 0.5) |
| `text-small-12` | pass | 43 | exact 1.000 (>= 0.25), CER 0 (<= 0.40), spurious 0 (<= 1.0) |
| `text-multilingual` | pass | 76 | exact 0.908 (>= 0.85), CER 0.0066 (<= 0.05), IoU share 1.0 (>= 0.90), diacritic exact 0.875 (>= 0.80; 56 units), spurious 0 |
| `static` | pass | 119 pairs | max shot score 4.6e-5 (< 0.03), max vector 0 px/s (< 2), max residual 2.3e-5 (< 0.03), false boundaries 0 |
| `hard-cut-high-contrast` | pass | 6 cuts, 0.21 min | recall 1.0, lowest cut score 0.9885 (>= 0.80), false boundaries 0 / min |
| `hard-cut-textured` | pass | 6 cuts, 0.20 min | recall 1.0, cut scores 0.24-0.34, false boundaries 0, false-motion share 0 |
| `crossfade-high-contrast` | pass | 4 fades, 0.14 min | every fade IoU 1.0 (>= 0.6), false boundaries 0 |
| `pan-slow` (12 px/frame) | pass | 2 segments | direction share 1.0, magnitude error 0, coverage 1.0, median residual 5.7e-6, lead-in false motion 0, false boundaries 0 |
| `pan-fast` (36 px/frame) | pass | 2 segments | direction share 1.0, magnitude error 0, coverage 1.0, median residual 2.3e-5, lead-in false motion 0, false boundaries 0 |
| `inserted-image` | pass | 4 inserts | `image-insert` not claimed (absent, `INSERT_GEOMETRY_NOT_COMPILED`), false boundaries 0, false motion 0 |
| `talking-head-synthetic` (drawn shape) | pass | 16 line-samples, 0.17 min | lower-third exact 1.0, CER 0, IoU 1.0, spurious 0, false motion 0, false boundaries 0 |
| `audio-no-face` | **FAIL** | 18 line-samples, 10 samples | exact 0.889 (>= 0.90), CER 0.0144 (ok), IoU share 0.889 (>= 0.90), spurious 5.5 / sample (<= 0.25) |
| `time-after-cuts` | **FAIL** | 22 line-samples, 2 mapped cuts | clock mapping exact (pass), seam pairs observed 0 (pass), observed pair set exact (pass), mapped cut recall 1.0 (pass), pan direction 1.0 (pass), false boundaries 0 (pass); **OCR exact 0.545 (>= 0.85) fails** |
| `crossfade-low-contrast` | informational | 2 fades | IoU 1.0 for both, no false boundary |
| `pan-subquantum` (4 px/frame) | informational | 89 pairs | median vector 0 px/s against 120 px/s labelled: not resolved, as the 12 px grid quantum implies |

Not run: `text-non-latin` (no traineddata, product restricted to por/eng), real-face talking head and the face producer (see the
pre-registration).

## Robustness (W63a contract), all on the real product path

| case | result |
| --- | --- |
| duplicate envelope | pass: same idempotency key returns the same operations, second worker claims nothing, one envelope row per producer; assembling the same envelope twice lists one `DUPLICATE_ENVELOPE` each and keeps the timeline hash |
| gap | pass: OCR `partial` with the exact complement, shot/motion `partial`, `image-insert`/`object`/`speaker`/`silence` `absent` with reasons, nothing `complete` |
| reorder | pass: (a) PTS-gap source refused by both producers (operations `failed`, no envelope row, no OCR/temporal input, `NO_PRODUCER_RUN`); (b) evidence of another version is rejected and listed, and the order it is handed over in does not change the snapshot hash; (c) `time-after-cuts-reordered-b` (source segments out of order) maps exactly |
| adversarial source | pass: an envelope row bound to other source bytes is refused at read with `PERSISTENCE_CONFLICT` (OCR and temporal), the unchanged rows read again; a file whose bytes differ from the declared SHA-256 makes both producers fail with no envelope written |
| replay | pass: three reads and a fresh-connection read return one snapshot hash and one row |

## Findings

1. **OCR works on solid backgrounds and breaks on a textured one.** On flat dark/light backgrounds Tesseract read every size from 56 px down
   to 12 px capital height with exact match >= 0.837 (1.0 at 20 px and 12 px); the pre-registered small-text criteria, written from the
   documented loss of accuracy below roughly 20 px, were not binding. On the textured background with a 78 % black box behind the text
   (`text-normal-c`, `audio-no-face-a`, the two `time-after-cuts` clips), the same engine missed or truncated words and produced many
   words that are not text (96 spurious words over 12 samples in `text-normal-c`; 55 over 10 in `audio-no-face-a`). All three failing
   strata fail only because of those clips; the two flat-background `text-normal` clips had 0 inexact units and 0 spurious words. The adapter
   OCRs the full frame with default page segmentation and no pre-processing; the product must keep treating OCR as unverified evidence and
   OCR on busy backgrounds as review-required.
2. **Two-language merging gives readings a consumer must resolve.** The adapter keeps both the `por` and the `eng` word when their text
   differs, so 44-63 % of text units (86 % in the cut clips) had more than one overlapping candidate word. After the confidence de-duplication of the pre-registered
   comparison, some diacritics are still lost when the `eng` reading outranks the `por` one (`Tributagao`, `Ultima`), and one duplicated word
   survived (`Ação e e resultado`). Diacritic exact match was 0.875 in the multilingual stratum, 0.774 in `text-normal` (31 units) and 0.714
   in `text-small-16` (28 units): above the multilingual criterion, but not perfect.
3. **Time after cuts is correct.** Every OCR observation sits on the timeline frame the label EditPlan gives its source frame (also with
   source segments reordered), the sampled-frame set is exactly the expected one, the shot-pair set equals the pairs inside the kept clips,
   the seam pairs are absent, the cut that lies inside a kept clip is found at its mapped pair and the one the edit removed is not invented.
4. **Boundaries and motion on raw scores are exact on this corpus.** Hard cuts, crossfades (including texture-to-texture: ramp pairs scored about
   0.0116 against at most 0.0001 outside the ramp) and pans at one and three grid quanta were all found by the fixed rules with no false boundary in the 2.8 minutes of footage of all clips;
   magnitudes were exact multiples of the quantum. Motion below the quantum (4 px/frame) is reported as zero, as the integer-shift estimator
   implies.
5. **Inserted images are not represented**, by design: `image-insert` stays `absent`. The large insert's appear/vanish pairs score about
   0.107-0.111 (Rule B flags them), the small insert's about 0.014-0.015 (not flagged): a consumer cannot recover an insert from the raw
   temporal values alone.
6. **A later producer run supersedes.** The evidence reader takes the latest OCR and temporal envelope of a version; a second run is not added
   to the first (observed on the development split and confirmed in `server-perception-evidence-reader.ts`).

## What this does not show

The clips are synthetic, noise-free and rendered with the same FFmpeg binary the temporal producer decodes with, at a single resolution and
frame rate; there is no natural footage, camera shake, occlusion, blur, other codecs, rotation or real faces. Several strata have 2-6
events. The labels were generated by the same author as the producers' tests, from first principles but not by an external party. A
pass here is a necessary regression check of the producer contract, not evidence of performance on the Imersão master or any real video.
In the product, OCR stays unverified and partial, shot/motion stay raw measurements, and no modality becomes `complete`; nothing in this wave
changes a product threshold.

## Reproduction (local only)

The evaluation needs the private corpora and the pinned local binaries, so it is not wired into hosted CI (the pure comparison code is:
`tests/v2/w63b-label-metrics.test.mjs` runs in `npm test`). Generation and evaluation run under the supervised harness:

```
APOLLO_S2D_CHECKOUT=<worktree> node <BASE>/run-local-pg-s2d.mjs <label> -- scripts/validation/w63b-generate-corpus.mjs --split <split> --out <dir>
APOLLO_S2D_CHECKOUT=<worktree> node <BASE>/run-local-pg-s2d.mjs <label> --plan <plan.json> --
  # plan step args: --experimental-transform-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/validation/w63b-evaluate.mjs --split <split> --corpus <dir> --out <dir>
```
