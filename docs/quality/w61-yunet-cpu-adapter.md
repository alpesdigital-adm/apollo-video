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

PR81 froze commit `8428e82702540598c049356ef024379e11a976b5`. Its local build
`checkpoint-build-v1-42a6c030` passed with 14 terminal identities and clean
postflight; result SHA-256 is
`408c396805ed7ae6307229c5f52786941020edf297d10719d46a8e6a76b0fe7d`.
CI run `38176386786` failed before unit/perception suites: trailing CRLF in
two new migrations and missing locked Remotion dependencies in the new job.
Dashboard run `38176386738` exposed an old upstream perception/Director fixture.
These failures remain failed evidence. The affected controlled journeys now
include T-FR, the five-format matrix, and W35 dashboard states/worker/events.
The dashboard correction must preserve the real API's 422 rejection with zero
effects before any test-only controlled approval port; persisted quality remains
review-required/unknown. It cannot establish editorial approval, facial safety,
deployment or owner acceptance. New-SHA local proofs and mandatory CI remain
pending; historical W35 results are not transferred to this checkpoint.

The original isolated-adapter record below is retained as history.

The rights/dashboard source revision passed literal `npm test` in
`rights-unit-v3-6fe3d9fa`: 2792 tests, 2785 passing, zero failures and the same
seven explicit skips. Result SHA-256:
`9a90a1b98dbbe376b922748bcfbdedecd8ac16f0f8d56891759daef0de94fae2`.
The source/test fingerprint was unchanged at
`7ef0b14cfd67d730c1c4ec9a88efa3f63abc1b07ac74d2426b2a93ea9f4e9421`;
35/35 process observations completed, 195 identities were terminal, and
postflight/scratch cleanup passed. This is pre-commit regression evidence.
Three preceding attempts remain failed supervisor runs (`rights-unit-v1`,
`rights-unit-depth`, `rights-unit-v2`): the literal npm/cmd wrappers added two
tree levels, and the private observer rejected a leaf at the allowed boundary.
The corrected observer still records every descendant and fails beyond depth
10 for that exact npm invocation (other commands retain depth 8). No tests were
selected out, and none of those interrupted attempts counts as a passing suite.

Rights-purpose correction prepared after the first CI run: OCR, temporal and
face analysis of the project's attached source master require `editing`, one of
the four uses granted by normal ingest. They neither require nor grant library
`editorial-reuse`. Direct video masters and uploaded audio require `rendering`
when materialized for a proxy; selected library inserts require `editorial-reuse`.
Unknown or ambiguous project associations fail closed. Workspace, locale,
consent, expiry, status and immutable source identity remain separate gates.
Admission, claim and publication check the current rights against PostgreSQL
time after lock waits. Diagnostic envelope reads check PostgreSQL time after
their queries; they do not promise a linearizable snapshot of mutable rights or
grant authority for a later render. Consumers that persist or publish must
revalidate within their own transaction and fences. The new controlled ingest
rights-stage test stops at an identified sentinel after real rights persistence;
it is not a complete ingest E2E. These changes still require the new commit's
local PostgreSQL proofs and mandatory CI before integration.

This adapter is **implemented in isolation, not integrated or approved** for W62. It consumes only explicitly sampled encoded PNG/JPEG frames with strictly increasing nonnegative `ptsMs` and an upstream `sourceSha256` assertion. The caller must establish source bytes, lineage and sampling. The adapter cannot establish coverage between samples, eye visibility, safe subtitle placement, tracking, or identity. Every unsampled interval remains unknown.

`YunetCpuFaceDetector.detect()` in `src/v2/infrastructure/perception/yunet-cpu-face-detector.ts` runs `yunet_cpu_bridge.py` as one owned child per batch. Input is one JSON request on stdin (`apollo-yunet-cpu-v1`) with model/source SHA-256, up to 30 frames, each encoded bytes plus SHA-256 and PTS. Output is one bounded JSON response with per-frame SHA-256, `observed` or `unknown`, reason for unknown, and up to 128 normalized `[left, top, right, bottom]` **XYXY** face boxes with confidence and clipping flag. `observed` with zero boxes means no face in that sampled frame at score >=0.50; any decode, size, inference or protocol failure is unknown/error, never absence. Inputs are at most 5,000,000 encoded bytes each and 20,000,000 per batch. PNG/JPEG dimensions are inspected before OpenCV decode: each axis <=8192 and <=20,000,000 pixels. The decoded dimensions must equal the header. Frames are decoded and processed sequentially. Response cap is 2,000,000 bytes; process timeout is at most 30 seconds. Abort/timeout kills and awaits child closure. Stderr is discarded; no frame pixels or paths are logged.

The Python bridge uses `cv2.FaceDetectorYN_create` with OpenCV DNN CPU, 2 threads and OpenCL disabled, 640×640 canvas, YuNet score 0.50 and NMS 0.30. It maps detector coordinates back to the original frame and clips to `[0,1]`. The model is the MIT-licensed OpenCV Zoo YuNet `face_detection_yunet_2023mar.onnx` pinned to [commit 47534e27](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet), exactly 232589 bytes, SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`. Python executable, bridge source and OpenCV native `.pyd`/`.so` binary are independently SHA-256 checked before spawn and in the child. OpenCV Python package is pinned to `opencv-python-headless==4.13.0.92`, reporting `cv2.__version__==4.13.0`. Runtime binary hashes are environment-specific; the Windows smoke used `C:/Python314/python.exe` and private `pydeps`, not an implicit production install. Installation is local, outside the repository: `C:/Python314/python.exe -m pip install --target <private-pydeps> --no-deps opencv-python-headless==4.13.0.92 numpy==2.5.1`; the caller supplies absolute paths and actual runtime hashes. No global install, remote inference, or paid API is required.

This code has a real pinned CPU smoke on one synthetic blank frame and malformed headers. That checks bounded execution and the output contract, **not detector accuracy**. Open Images corpus V1–V4 are preserved as failed or incomplete pre-inference acquisition attempts; [V5](./w61-visual-preflight-v5.md) is a separately preregistered CVDF-derivative, Rotation-0 acquisition with no face inference yet. Development/calibration accuracy, sealed holdout, visual video strata and reviewed master remain separate gates. The PostgreSQL/HTTP OCR producer proof is also not facial validation. No product status or TODO completion follows from this adapter alone.
