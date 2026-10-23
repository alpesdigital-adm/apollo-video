# ADR-160 — Linux parity of the V9 face detector: named criterion and byte-bound receipt

## Status

Accepted by the owner on 2026-10-22 (Brain #3803). Implemented on branch `claude/v9-linux-parity-receipt`. Not deployed.

## Context

The W62 deployment gate said the Linux runtime would enter `ACCEPTED_FACE_PRODUCERS` only after the 60 development images ran through the detector there and the outputs matched the V9 tensors **byte for byte**, without tuning. Until then `createFaceWindowWorker` refused to start on Linux and a Linux envelope was not authenticated.

The supervised run was made on 2026-10-22 on the same 60 images: Windows (Python 3.14, reference), Linux Intel (Python 3.12.3, DigitalOcean nyc3) and Linux AMD EPYC 9555P (Python 3.12.3, DigitalOcean ric1), OpenVINO 2026.4.0, OpenCV 4.13.0, NumPy 2.5.1 on all three. Detections with score >= 0.5 are identical (V9 61/61, retail-0004 52/52); the largest box or score difference is 3.6e-7 (Intel) and 8.9e-7 (EPYC). Raw output tensors are byte-identical in only 1/60 (V9) and 53/60 (retail-0004) and depend on the CPU.

The original criterion is therefore **not met**. It was not relaxed in code: the owner decided, with this measurement in front of him, to accept parity on the weaker, explicitly stated property below.

## Decision

1. **Named criterion `detections-identical-max-delta-1e-6`.** On the development images, detections with score >= 0.5 of the Linux runtime equal those of the Windows V9 runtime in count and order per image, and no box coordinate or score differs by more than 1e-6. Tensors need not be byte-identical. The name is carried by the registry entry (`parityCriterion`) and by the receipt (`criterion.id`); a test checks that the recorded results satisfy it.
2. **The receipt is a versioned document, referenced by hash.** `docs/quality/w62-v9-linux-parity-receipt.json` holds summaries and SHA-256 of the evidence (comparison, environment, inputs manifest, outputs, runner), never pixels. Its own SHA-256 is `parityReceiptSha256` of the `linux` entry and is what a Linux envelope must present (`RUNTIME_PARITY_MISMATCH` otherwise). The file is pinned `eol=lf` in `.gitattributes`.
3. **The receipt is valid only for the measured bytes.** The `linux` entry pins the interpreter (`pythonExecutableSha256`), the runtime package manifest (`runtimeManifestSha256`) and the bridge (`bridgeSha256`), and carries the exact Python/OpenVINO/OpenCV/NumPy versions; the model hashes are the producer's. Any other value yields `PYTHON_EXECUTABLE_PIN_MISMATCH`, `RUNTIME_MANIFEST_PIN_MISMATCH` or `BRIDGE_PIN_MISMATCH` (envelope not authenticated) and `createFaceWindowWorker` refuses to start before reading the runtime. The previous behavior stays for platforms without an entry (`RUNTIME_PLATFORM_NOT_PARITIED`).
4. **Other platforms are untouched.** `win32` keeps its own V9 development receipt, no byte pins, criterion `v9-development-receipt`; its flow and error order in the factory are unchanged.
5. **Bridge pinned is the worker bridge.** The measurement executed `openvino_pixel_oracle_bridge.py`; production runs `openvino_face0204_bridge.py`. Both feed V9 identically (BGR, direct bilinear resize to 448x448, NCHW float32, CPU, 2 threads, 1 stream, LATENCY, f32). The registry pins the worker bridge; the oracle bridge hash is recorded in the receipt as `measuredOracleBridgeSha256`. On Windows the worker bridge reproduced the oracle bridge's V9 tensors in 60/60 (one run). The worker bridge itself was not run on Linux.

## Consequences

- The detector can start on Linux only with the interpreter, runtime manifest and bridge named by the receipt. Changing any of them (a new Python build, a package upgrade, an edit of the bridge) requires a new measurement and a new receipt.
- Parity is shown for two CPU families (Intel, AMD EPYC) on one OS image. Another CPU family is not measured; the byte-level tensors differ by CPU, so the 1e-6 bound is evidence, not a guarantee.
- The 60 images are a development set with n = 1 run per platform; dispersion across repeated runs on one host was not measured.
- `FACE_EVIDENCE_POLICY.claims.deploymentGate` still reads `linux-parity-run-on-60-development-images-pending`. It is part of the policy hash that stored envelopes carry, so changing it would change `policySha256` for existing evidence and for Windows. It is left as the historical value of policy `w62-v9-foreground-evidence/v1`; the live state of the gate is the registry entry and this ADR. A later policy version may drop it.
- This is parity of detector output only. It is not a qualification, does not change `faceSafety` (`unknown`) and does not replace the real-video measurement of the W70 journey.
