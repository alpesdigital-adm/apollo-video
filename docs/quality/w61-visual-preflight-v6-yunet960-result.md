# W61 V6 YuNet 960 — frozen development and calibration result

The [V6 preregistration](./w61-visual-preflight-v6-yunet960.md) tested one fixed 960×960 YuNet configuration on the same 120 V5 development/calibration images. Both supervised runs completed all 60 selected images without a failed image, process timeout or changed threshold. The 60-image holdout remains sealed.

| Set | Matched human boxes | Recall | Negative images with a false face | Resource benchmark | Outcome |
| --- | ---: | ---: | ---: | --- | --- |
| Development | 52/67 | 77.6% | 4/20 = 20% | median 57.5 ms, p95 106.4 ms; peak RSS 153.4 MB | Fails recall ≥95%, negative FP ≤10%, and qualifying-stratum recall ≥90% |
| Calibration | 50/58 | 86.2% | 5/20 = 25% | median 62.2 ms, p95 73.7 ms; peak RSS 152.4 MB | Fails recall ≥95%, negative FP ≤10%, and qualifying-stratum recall ≥90% |

The 960 canvas did not improve total matched boxes compared with V5 YuNet 640 on these same splits (52/67 development, 50/58 calibration). Development small-face recall rose to 10/10, but this came with 70 unmatched detections in that positive stratum and 85 unmatched detections overall. Calibration small-face recall was 9/10 with 12 unmatched detections there and 34 unmatched detections overall. These unmatched predictions are diagnostic; the preregistered negative-image false-positive gate uses only the 20 explicitly negative images in each set. Resource latency and memory gates passed. Passing resource gates does not offset failed accuracy gates.

The results are still-image diagnostics on Open Images CVDF derivatives, not a video/eye/final-pixel safety evaluation. The prior corpus limitations remain, including partial original-aspect verification and no guarantee against near-duplicates. No result grants `faceSafety=verified` or permits subtitle/crop safety claims. Holdout, integration approval, deployment and owner acceptance remain pending.

## Evidence and reproducibility

- V6 protocol/evaluator SHA-256: `6ec1eb3eb49ca39f06a35e7f25594e1cc02bbda2ca76044512dce1c2059056bf` / `b116938e8f54ce50789c62917b42d2d6b041bcb3f9aa77f752da6e7a71d96a93`.
- Private V6 freeze SHA-256: `25edcaee360380653dcd490dc585b3b7ae5a59dcbefaa7c6d327e3082ceb5653`.
- Detector configuration check SHA-256: `cefe20e27391dbb8bc356de54f0e933b2a24eb5f99cf30bbd3c23f119a39851d`; it instantiated YuNet with input size 960×960 and recorded `detectorCalled=false`.
- Development report SHA-256: `f720031bff264ed1e20cbce27a3bd6cc6beab92dd1ee3e034d29fc51db911b80`; supervisor SHA-256: `c3c3d23885af655d1f4b9b4291915f8d1f265cefdc50e902a53c996c2b030e53`, child PID 60248, exit 0, terminal.
- Calibration report SHA-256: `ba1260a95a22ce23a729e8213bbbdba1ba8b3193ae1f9fa3e269efa905a8c357`; supervisor SHA-256: `fa0bd73cf3f88294ee992fe9182377e0e11e303879052a2fea5fcdb4ebaf9e73`, child PID 41296, exit 0, terminal.

Reports, selected-image bytes and provenance HTML remain in the private W61 evidence directory and are not committed.
