# W61 V7 Intel retail-0004 — frozen development and calibration result

The [V7 preregistration](./w61-visual-preflight-v7-openvino-retail0004.md) tested one Intel `face-detection-retail-0004` FP32 configuration on the same 120 V5 development/calibration images. Both supervised runs ended normally, but the candidate **failed the accuracy gate**. The separate 60-image holdout was not opened. No image, label, threshold, model, or configuration was changed after the freeze.

| Set | Images evaluated / selected | Human boxes matched | Explicit negative images with a false face | Resource benchmark | Gate result |
| --- | ---: | ---: | ---: | --- | --- |
| Development | 59/60; one invalid model box | 43/67 = 64.2% recall | 3/20 = 15% | median 10.7 ms, p95 12.4 ms; peak process RSS 150.6 MB | Fails recall ≥95%, negative FP ≤10%, and positive-stratum recall ≥90% |
| Calibration | 56/60; four invalid model boxes | 37/58 = 63.8% recall | 2/18 observed = 11.1%; conservative upper bound 4/20 = 20% when failed negatives count against the gate | median 6.7 ms, p95 20.1 ms; peak process RSS 150.6 MB | Fails completeness ≥90% in the multiple-face stratum, recall ≥95%, negative FP ≤10%, and positive-stratum recall ≥90% |

The image-level completeness gate for each **whole set** passed (98.3% and 93.3%). Calibration's multiple-face stratum was only 8/10 complete; this is reported as a stratified limitation, not substituted with another image. The five invalid boxes (`DETECTOR_FACE_BOX_INVALID`) remained failed images. Human-face recall includes missed ground-truth boxes from failures in its denominator. Development stratum recall was multiple 20/37, lower 6/10, small 9/10, single 8/10; calibration was multiple 15/28, lower 6/10, small 9/10, single 7/10. Both sets missed many human faces despite the model's low CPU/RAM cost. The resource gates passed but cannot offset these accuracy failures.

The five known animal negatives were a post-hoc diagnostic subset of the fixed 40 negatives, not a separate validation sample. The model emitted two detections for the development monkey and one for the parrot. In calibration, it emitted one for one cat; the other cat and the dog had invalid-box failures, so they cannot be counted as successful animal rejections. These observations do not establish human-versus-animal discrimination. No cases were excluded or reannotated.

These are still-image measurements on licensed Open Images CVDF derivatives. The source-audit limitations, including partially unverified original aspect ratio and possible near-duplicates, still apply. The benchmark does not validate video timing, eyes, subtitle placement, crop safety or final pixels. `faceSafety` remains `unknown`; the failed candidate is not approved for export authority or deployment.

## Evidence

- Frozen V7 protocol SHA-256: `1c813d9e044b7928e74f35a31040aba0f1d4513792faf33f438adaea2539614b`; evaluator SHA-256: `bae42a487b6652a90240de65c72373a1dc0db407b4806c5a9fa20da6ac699951`; private evaluator freeze SHA-256: `96714c97d6af76771e1175c447dfc9eac61f7bea5dfbc8021a0dea2bae9b4e22`. The detector-free configuration check SHA-256 was `a027b3781a0a941b27fda4c1cbad919095104b22beae3e19fdd3cf44bd70b99e`.
- V5 fixed manifest SHA-256: `74cc75cf7a188bca692f51c22cbde1ecd8754bd2ef059a613672bef0acfd9927`; detector-free 180-item source audit SHA-256: `e5056b33e4960404f2e19f000185378bae8760dabd083e8e7b3b8b97e5e7b49b`.
- Publisher SHA-384 and local SHA-256 verified before inference. Local XML SHA-256: `90922d199016d18128bdaba488bdb1628fce50efcc81155ede7949cbba3dd979`; BIN SHA-256: `89349ce12dd21c5263fb302cd3ffd4b73c35ea12ed98aff863d03a2cf3a32464`.
- Development report SHA-256: `84a32c4cbd0e0f35d888bf6dc998a86734b46176026b593f21a23d8816191926`; supervisor ledger SHA-256: `28348d7e83a36b6db1d58041b4611481242b70490334814881d26d799f4e6104`, child PID 64772, exit 0, terminal, no timeout.
- Calibration report SHA-256: `3dc101aa95b5bf19dd11f6504614e294d6173620ac6ff2eaf31475164c593e83`; supervisor ledger SHA-256: `fd7f9f45f72cec2fd3556c81326ce9062b32577b9d85e0d0d9101498be97f1c9`, child PID 24812, exit 0, terminal, no timeout.

Detailed per-image predictions, failures, runtime hashes, and licensed source bytes remain in the private W61 evidence directory; they are not committed.
