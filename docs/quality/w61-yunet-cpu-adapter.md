# W61 isolated YuNet CPU adapter candidate

## Controlled integration checkpoint — 2026-10-11

The diagnostic producer now has local PostgreSQL/HTTP proofs while all evaluated
models remain failed-gate and faceSafety remains unknown. The proposed CI job
runs only the three offline fixture/audit assertions in
`tests/v2/prisma-face-producer.integration.mjs`; its PostgreSQL and real runner
cases still require private licensed development inputs and pinned runtime.
`tests/v2/prisma-face-producer-http.integration.mjs` is explicitly unrun in CI.
The local HTTP result `face-http-resume-v1-39bfb5da/result.json` has SHA-256
`1fa3c5960fdc2ce7bb9d7ee4cd72bc1c51fff76b10e878cfec0787f828be2fb9`, one passing
test without skips and clean process/database postflight. This proves diagnostic
mechanics, not approved facial accuracy, final pixels, deployment or acceptance.
The holdout remains closed. CI wiring is pending execution on the reviewed commit.

Regression preparation retained two failed full-suite runs. The first,
`unit-resume-v1-4f5b9b8c`, had 43 failures: 18 Windows shell-resolution errors,
10 missing local FFmpeg-path errors, nine native TypeScript parameter-property
import errors, and six stale contract/migration/wiring expectations. The second,
`unit-resume-v2-f93aff81`, ran 2776 tests (2767 passed, three failed, six skipped),
after configuring explicit local binaries and Git Bash without modifying the
dependency or user-profile installation. It exposed two old reusable-proxy
fixtures missing the authenticated map/manifest and the unfinished CI supervisor's
detached-process violation. Its result SHA-256 is
`79d897fead360c4f7d621007e99eac012ef74d6196e4c2084ee25abd3479b45b`;
process postflight was clean. These failures are historical failures, not passing
evidence for a later commit.

The six existing unit-suite skips are one opt-in PostgreSQL timeline case and
five pinned local YuNet/video runtime cases. They are not facial CI coverage.
The corrected proxy fixtures have focused 22/22 passing tests, including missing,
tampered, old-recipe and wrong-version receipts; this is controlled repository
behavior, not an independent pixel or detector-quality proof.

The subsequent full local run `unit-resume-v3-7f076ca8` passed 2776 of 2783
tests with zero failures. Its seven explicit skips comprise the six cases above
and the new Linux process-supervisor scenario on Windows. Result SHA-256:
`c4a9e8aae51a40c2b7415fff2df2bfd83a20b26ecb45b00433d36379588c52f8`.
The tracked source/test fingerprint remained
`0c09916d4e3b43255c9274cf202187291c6a7a5b76a113a41a1d4fa7038ca099`;
106 observed identities were terminal and postflight was clean. This is a
pre-commit regression checkpoint, not the subsequent commit's build/PG proof
or execution of the Linux pidfd/setsid scenario.

The original isolated-adapter record below is retained as history.

This adapter is **implemented in isolation, not integrated or approved** for W62. It consumes only explicitly sampled encoded PNG/JPEG frames with strictly increasing nonnegative `ptsMs` and an upstream `sourceSha256` assertion. The caller must establish source bytes, lineage and sampling. The adapter cannot establish coverage between samples, eye visibility, safe subtitle placement, tracking, or identity. Every unsampled interval remains unknown.

`YunetCpuFaceDetector.detect()` in `src/v2/infrastructure/perception/yunet-cpu-face-detector.ts` runs `yunet_cpu_bridge.py` as one owned child per batch. Input is one JSON request on stdin (`apollo-yunet-cpu-v1`) with model/source SHA-256, up to 30 frames, each encoded bytes plus SHA-256 and PTS. Output is one bounded JSON response with per-frame SHA-256, `observed` or `unknown`, reason for unknown, and up to 128 normalized `[left, top, right, bottom]` **XYXY** face boxes with confidence and clipping flag. `observed` with zero boxes means no face in that sampled frame at score >=0.50; any decode, size, inference or protocol failure is unknown/error, never absence. Inputs are at most 5,000,000 encoded bytes each and 20,000,000 per batch. PNG/JPEG dimensions are inspected before OpenCV decode: each axis <=8192 and <=20,000,000 pixels. The decoded dimensions must equal the header. Frames are decoded and processed sequentially. Response cap is 2,000,000 bytes; process timeout is at most 30 seconds. Abort/timeout kills and awaits child closure. Stderr is discarded; no frame pixels or paths are logged.

The Python bridge uses `cv2.FaceDetectorYN_create` with OpenCV DNN CPU, 2 threads and OpenCL disabled, 640×640 canvas, YuNet score 0.50 and NMS 0.30. It maps detector coordinates back to the original frame and clips to `[0,1]`. The model is the MIT-licensed OpenCV Zoo YuNet `face_detection_yunet_2023mar.onnx` pinned to [commit 47534e27](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet), exactly 232589 bytes, SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`. Python executable, bridge source and OpenCV native `.pyd`/`.so` binary are independently SHA-256 checked before spawn and in the child. OpenCV Python package is pinned to `opencv-python-headless==4.13.0.92`, reporting `cv2.__version__==4.13.0`. Runtime binary hashes are environment-specific; the Windows smoke used `C:/Python314/python.exe` and private `pydeps`, not an implicit production install. Installation is local, outside the repository: `C:/Python314/python.exe -m pip install --target <private-pydeps> --no-deps opencv-python-headless==4.13.0.92 numpy==2.5.1`; the caller supplies absolute paths and actual runtime hashes. No global install, remote inference, or paid API is required.

This code has a real pinned CPU smoke on one synthetic blank frame and malformed headers. That checks bounded execution and the output contract, **not detector accuracy**. Open Images corpus V1–V4 are preserved as failed or incomplete pre-inference acquisition attempts; [V5](./w61-visual-preflight-v5.md) is a separately preregistered CVDF-derivative, Rotation-0 acquisition with no face inference yet. Development/calibration accuracy, sealed holdout, visual video strata and reviewed master remain separate gates. The PostgreSQL/HTTP OCR producer proof is also not facial validation. No product status or TODO completion follows from this adapter alone.
