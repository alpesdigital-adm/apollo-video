# W61 V5 result — YuNet CPU candidate remains blocked

This is the result of the frozen [V5 preregistration](./w61-visual-preflight-v5.md), not a revision of its selection or thresholds. The preregistration document SHA-256 is `e9de632da25f730b884ab6128830be99656836688e6d20cdec26c756aa48bba6`. The CVDF-derivative corpus manifest SHA-256 is `74cc75cf7a188bca692f51c22cbde1ecd8754bd2ef059a613672bef0acfd9927`; the pinned YuNet weight SHA-256 is `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`. Evaluator SHA-256 `a21e3fa5b91976a9eab65df26e3d47f75afb8e4a7fc985424aabc51963193eb1` and supervisor SHA-256 `4ee69e39feafb1e84b64b1b29ede0766a05d1801701528b00d73139852cff889` were fixed before face inference.

The supervised source audit first verified and decoded **180/180** selected images without invoking the detector: 60 development, 60 calibration, 60 sealed holdout, with the preregistered 10/10/10/10/20 stratum quotas in each set. All 180 image IDs, JPEG byte SHA-256 values and decoded BGR pixel SHA-256 values were unique; all 180 original-photo HTML license proofs and Rotation-0 CVDF bytes passed the frozen checks. Audit report SHA-256 `e5056b33e4960404f2e19f000185378bae8760dabd083e8e7b3b8b97e5e7b49b` records zero failures, `detectorCalled=false` and `inferenceCount=0`; its supervised child PID 60968 exited and was verified absent. The private pre-audit freeze SHA-256 is `40723102f1befef634b7493267d311b2127295d2573158dfc41eb6865c9d243c`.

Only **36/180** CVDF JPEGs had a prior verified original available for empirical aspect comparison, all in development. The other 144, including every calibration and holdout image, are explicitly `aspect_original_unverified`; they rely on the official CVDF split/ImageID mapping, Rotation-0 metadata and neutral EXIF. CVDF JPEGs are resampled/re-encoded derivatives, sometimes upscaled, and are not authenticated by Open Images `OriginalMD5`/`OriginalSize`. Distinct exact hashes do not rule out near-duplicate photographs. The dataset's human face boxes can omit faces or be occluded/truncated; it has no independent eye, skin-tone, blur or video ground truth here. These limits preclude general face-safety claims.

| Fixed score 0.50, NMS 0.30, IoU 0.50 | Development | Calibration |
| --- | ---: | ---: |
| Images evaluated / selected | 60 / 60 | 60 / 60 |
| Annotated faces matched | 52 / 67 | 50 / 58 |
| Recall, including failures | **77.6%** | **86.2%** |
| Observed precision | 62.7% | 61.7% |
| Negative images with a detection | 2 / 20 (10%) | **3 / 20 (15%)** |
| Multiple-face recall | 75.7% | 92.9% |
| Lower-face recall | 70% | 70% |
| Small-face recall | 90% | 90% |
| Other single-face recall | 80% | 80% |
| 30-run CPU spike median / P95 | 26.1 / 73.3 ms | 26.7 / 55.9 ms |
| Additional peak RSS | 73,793,536 bytes (70.4 MiB) | 73,781,248 bytes (70.4 MiB) |

Both CPU spikes pass the preregistered median <=150 ms, P95 <=500 ms and additional peak RSS <=512 MiB on the pinned Windows/OpenCV CPU process with two execution threads. This proves the bounded local resource budget for these still images, not video runtime safety. Development report SHA-256 is `55c4f6e3f639db80a1a02ceed2b249fba84492d0bbea53b50d53a3c222d8191d`; calibration report SHA-256 is `d29c1ca49344d027048e785d4baef0b2ce127f2f831223b7b5d63da9c8108b8b`. Each contains all per-image predictions, matches, confidence bins, failures and runtime measurements. Both runs completed 60/60 with zero evaluation failures; their supervised child PIDs 61840 and 41004 exited and were verified absent.

A post-hoc read of only those two reports and their annotated development/calibration boxes found 23 missed faces: 11 occurred in images with no prediction, 10 had best predicted-box IoU below 0.30, and two had best IoU from 0.30 to below 0.50. None had an unmatched prediction at IoU >=0.50. At the fixed 640-pixel preprocessing scale, 4/5 annotated faces with minimum side below 16 pixels were missed, but 15/100 with minimum side at least 32 pixels were also missed. Lower-position faces missed 8/26; upper-position faces missed 4/52. The five negative images with false positives include confidence scores from 0.568 to 0.909, so a confidence increase cannot be presumed to remove the problem without sacrificing recall. This descriptive analysis did not test new parameters or use the holdout; private analyses SHA-256 are `896c46da9fb13fbe0e94839dc904480b1e727b607ba826e9c9be06896813747f` and `208ace3f17ce1e7e9ecd3a5d813775db6c164f0b4b1ed36c5b932bf0e6d81e40`.

Astra visually inspected the five negative images with false positives after evaluation: one monkey, one parrot, two cats and one dog. This qualitative diagnosis supports investigating animal-face confusion; it is not a new ground-truth annotation, independent human acceptance, or grounds to exclude these images. No labels or corpus selections were changed.

The observed development/calibration recall falls well short of the intended >=95% holdout overall-recall threshold, and calibration's negative-image false-positive rate exceeds 10%. Those are **preliminary diagnostic sets**, not a substitute holdout score. This candidate is **not approved for face-safe subtitle placement, cropping, W62 integration or a `verified` face-safety claim**. The holdout's images were acquired and source-audited but **never passed to the detector**; its labels and performance remain sealed. No threshold, model weight, sample selection or annotation was changed after seeing predictions. Product approval still requires independent video/eye coverage, final-pixel critic and reviewed MP4.

All JPEGs, HTML license proofs, manifests, source-audit/evaluation JSONs and supervisor logs are private under `C:/Users/leand/Documents/Apollo/w61-70-20261008/`; they are not repository artifacts. Earlier V1–V4 acquisition failures remain documented in their original records and do not contribute accuracy observations to this V5 result.
