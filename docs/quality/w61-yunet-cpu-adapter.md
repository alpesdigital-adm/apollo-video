# W61 isolated YuNet CPU adapter candidate

## Latest controlled checkpoint — 2026-10-12 UTC

The subsequent workspace v13 change derives annotation and report availability
separately in one PostgreSQL RepeatableRead snapshot, including operations. Stored
manifests must validate their domain hash and match artifact/manifest rows and
protected references; GET does not decode media or decrypt payloads. Historical
schemas remain unchanged. The browser ledger correlates exact-request transport
failure with body completion and records restricted RSC headers, without exempting
aborted requests.

Pre-commit checks `workspace-v13-checks-v3-0fa6e0a0` passed 68/68 tests, strict API
contracts, architecture and status generation/check (result SHA-256
`850e4939bbe90a7527297a4d893b1fdcb655f92e6e83e7f14bc89904355a3e2d`).
The first two attempts remain FAIL: a missing closing brace, then strictRequired
in the new schema. PostgreSQL run `workspace-v13-pg-v3-657ad865` passed 1/1 with
the real head-change latch, old/new aggregate consistency, manifest/scope
rejections and rollback/readback (result SHA-256
`94525aca5f66bb4a62879d3dfc02efdadcadbe5eb97862ae79c915e5f08144ce`).
Its six observed identities were terminal, four PostgreSQL observations empty,
cluster/port/scratch clean and source fingerprint unchanged. Earlier PG attempts
failed during fixture preparation (UUID links, then duplicate immutable snapshots)
and are retained. These are controlled database facts, not rendered-media or
editorial approval. Fresh build, annotation/manual regressions and dashboard on
the next frozen commit remain pending.

Follow-up evidence on local commit `0146d89e31bebb8d8e1884ad677f1e5a9d627a78`
does not close the checkpoint. Dashboard v6 (`dashboard-0146-v6-447eed01`, result
SHA-256 `3a4684546b4a076ab5db578d38d29e1419123ab6d66ae75f68e11cdf10bb16f4`)
failed before its first recorded state. The request barriers completed, but the
draft project requested annotations and proxy review without an available proxy:
both returned real `PROJECT_NOT_FOUND` HTTP404 responses. Separately, 22 RSC
requests failed with `net::ERR_ABORTED`; content type or Next source code containing
reader cancellation does not establish why these transports aborted. All 34
observed identities were terminal, four PostgreSQL samples were empty and scratch
cleanup completed. The authenticated bundle was built from a37; test source was
0146. The subsequent workspace v13/review-availability v1 implementation is still
unvalidated working-tree code and requires its own fresh build, PostgreSQL and
browser evidence. It separates annotation and report availability within one
RepeatableRead snapshot; it must not turn an available resource's 404 into absence.

W69 differential v5 (`w69-ass-clock-v5-differential-5f07883b`) remains a physical
FAIL. The original cases retain 22 passes, the first failure at index22 and 19
not-executed cases. Diagnostic collection completed all 42 entries (24 observed
controls, eight passes and ten failures), with 73 FFmpeg executions exiting zero.
At frame803/100fps, ASS [8.02,8.03) changed frames802 and803 in both graphs;
[8.03,8.04) changed no selected frame with lavfi and frame804 after concat.
Both subtitle and CTA layers reproduced this result. This is observed pixel
behavior, not a measurement of libass's internal integer timestamp. Moving the
boundary earlier would also include frame802. FPS-only policy is therefore not
approved; a future materialized clock must reject unrepresentable intervals and
bind the real PTS/time base, graph and executable identities before new pixel proof.
V4's ENOBUFS and every original expected frame remain preserved.

V5 result SHA-256 `18e3d5e5efcb4074c789f525458e9eeceaa8af14c934a8b01eca2fc2cf117e3a`;
proof `d3d41f5befabb32b612e621e553163136eb7676d8ac2c6eabb43b57431ed0931`;
manifest `3805d9f7d22092683c2163b4a08bb16cac304cf8145c3895f6c510245f40cfb6`.
All 281 files (98,114,774 bytes) were rehashed without differences. The source
fingerprint `23c29fd756ffe0dae17f489774d5a4075be265591c6d34932144f4083cc6bf2c`
was stable; all 11 observed identities were terminal, no database started and
scratch/postflight cleanup completed. No emission policy or runtime was activated.

W66's separate origin scaffold passed six pure tests in
`w66-origins-v2-32686992`, result SHA-256
`bda81e13bedfe0eb0e011ea994ca7b49667bd98688758bf0e6de3c313eea74e6`.
Only create/revise output commands return readiness for the existing isolated
bundle; the six other origins remain blocked without persistence. The fork
positive uses an empty plan with a variant, not clips/cues/overlays. V1's failed
fixture/guard run is retained. This neither reruns the earlier 36 pure/16 PG
contract tests nor implements the sixteen-writer cutover or deferred-COMMIT proof.

PR81 remains blocked. The reviewed integration base is `dcc0b46b35909c9badb19b2d912f54e25176ded9`;
the local corrections below are later working-tree sources with their own fingerprints,
not evidence that this head or the next commit passes all gates. No TODO row, deployment
or owner acceptance is promoted. Diagnostic face evidence remains unknown and all
failed model gates and the closed holdout remain unchanged.

CI dcc0 is terminal: central `38187207475` failed after Compose local/S3 passed;
Quality failed the extraction fake's replay and perception failed the rotation fixture.
Dashboard `38187207482` failed the seeded operation's progress-bar expectation.
Media `38187207444` passed controlled mechanics. The respective download manifests
are retained privately; central manifest SHA-256 is
`63c2c3f9d1943fbc7233778bdd54691708f18f0f061fda00120ef752e55441db`.
The official Compose postflight recorded zero backends and terminal containers;
the three owned backends in an earlier internal JSON precede disconnect and are
not the postflight. A new reviewed SHA still needs the complete mandatory CI.

| Later local source | Result | Exact proof boundary |
| --- | --- | --- |
| W9 `wave9-controlled-dcc0-v3-6900ce4d` | 3/3, zero skips | Real worker/FFmpeg, atomic attachment/review/success in memory; each track owns its effective preset and cues, content hash and fixture snapshot seal; original Director unchanged. Timing/audio/color, modes/revert/replay and tamper negatives remain. Unknown face coverage suppresses cues and blocks final. |
| W10 `wave10-controlled-dcc0-v1-c62a0210` | 2/2, zero skips | Planned Commands/presets/overrides, physical timing/audio/color and integrity negatives; atomic port in memory. Unknown face coverage suppresses cues. Sidecars reject with exact `SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH` and zero effects. |
| Extraction `extraction-controlled-dcc0-v1-64e3d689` | 11/11, zero skips | Real FFmpeg pixels/timing and replay without a second render; corrected atomic in-memory port. |
| Temporal `temporal-adapter-dcc0-v2-f26dca46` | 1/1, zero skips | H264/MP4 input rotation set by `-display_rotation:v:0 90` before remux input; ffprobe structural 90-degree assertion and rejection before decode preserved, with the other FFV1/PTS/cut/pan/abort/deadline cases. |

Result SHA-256 values, respectively:
`c092603796009807cab625f607da400ca503f9f423da5086e2fd368d561f8ae7`,
`f043356919743df6b82f1c82488fb7127addbfa882d82952f9b0d4947f4c575e`,
`9332a33ba334bffdfcd1de4df97f0dbf2e0dad5a280d2315f5e829271e5ce664`,
`75db92872d7b30b9bc171e0ef919ee149e908bd839d9d838c2769a8af78d8bcb`.
Each has a stable before/after source fingerprint, terminal observed processes and
clean scratch postflight; these runs did not start PostgreSQL. W9v1/v2 and the earlier
rotation failure remain failed historical runs. These results establish neither
positive caption pixels, facial safety, positive SRT/VTT, PostgreSQL publication of
the in-memory ports nor editorial/final acceptance. The present Prisma source adapter
still does not materialize subtitleResolution; W9's fixture is not that missing runtime.

W35 positive final admission remains pending. The real project stays revising with
review-required/unknown quality and blocked review; public and PostgreSQL admission
must reject final with zero effects. Reviewing-proxy and the succeeded proxy operation
in the second project are explicit seeds. Dashboard localv4 passed its assertions but
recorded two browser errors (workspace GET409 and console); it is not a clean-browser
proof. The new test-only correction compiles the actual copied source through the public
color API before inserting the seeded operation, hydrates the persisted compilation,
and seals source/manifest/compilation/pipeline hashes in its binding. It requires public
workspace200 before the seeded GUI observation, awaits bounded response evidence, and
fails on page errors, HTTP errors or unexplained conflicts, including late errors after
browser close. Local commit `a37be5a8bf9dc7f7301c60ce6c744d3f58a95096`
passed the fresh build (`build-a37be5-08768a38`, result SHA-256
`1414acff94dce72b18b4fa92d6b245143b6146482872a7d84f600a1164bd307c`).
Its 1,922 bundle files (333,404,910 bytes, excluding cache and trace files) still
matched manifest `4ffa80f0c13551178f89f1eee754a54d5ca6a2b9a0ca3af76c077bccb4cf0643`
after the following run.

Dashboard `dashboard-a37be5-v5-8be9607c` failed before its first recorded state:
four HTTP200 JSON response bodies could not be captured (`proof-needs`,
`proof-integrity-runs`, `proof-mode-runs`, `capabilities`). Each error had 227 bytes
and SHA-256 `09aac9fb62b8c75d5c3d78f02bfc265ba1c23d2f010c594116f75e3a330bb393`.
Result SHA-256 `8242330efb542cc796a23f565719061e2af21b5353472023d7398f3345035833`;
source fingerprint `edae54a4a7ffd3967b069eb3136bc75963888f1cd4b117c16d359bd13db5bc3e`
remained unchanged. All 36 observed identities were terminal, four PostgreSQL
postflight samples were empty and cluster/scratch cleanup completed. Neither the
proxy nor the seeded project was exercised in this failed run. The response-only
ledger does not track requests awaiting headers or later hydration effects;
navigation-induced loss is a hypothesis requiring request lifecycle evidence,
not a reason to ignore body failures. Rendering-final, completed, final MP4 and
final replay remain outside the current proof.

W66 is a separate uncommitted draft on base8428e827. Manifest
`w66-output-facts-v7.json`, SHA-256
`2f391bf3e00845cd05e2fb428a208eaf6820b68f657b759bad966628b6d2d0bb`,
anchors fourteen files, 36/36 pure tests and 16/16 isolated PostgreSQL tests, all without
skips. Pure result SHA-256:
`a351daa61b0369fa330f97b48c162e651fd5fe9fc113d0492b39d169bb7486a4`;
PG result SHA-256:
`c48dfa6ba67cef24926a1115716f05d5c3d604ec0c219649a76f248ca0319a5c`.
The PG cluster, port and clients are terminal and scratch is clean; the subsecond pure
run has no descendant inventory claim. New canonical seals preserve historical hashes.
The slice covers State/Version binding, explicit variants, crop-only dependencies,
create/revise preservation of siblings/plans/overlays/issues, authoritative persisted
non-output snapshot facts and Command author/time. It does not implement the sixteen
writer/hydrator/consumer cutover, ingest/fork-with-content/director/inherit/restore
origins, lifecycle/rights races, historical contract0 upgrade or observable deferred
COMMIT failure. CreationCommandv1 does not seal original caller intent for brief/policies.
Its current rate1, matching source/plan fps and single base-video limits must not become
a runtime cutover that rejects retiming/multitrack behavior already supported by the
product; those origins need explicit normalization, clock/rate and geometry facts.

W69 physical timing is blocked. `w69-ass-clock-v2-ec9c135a` failed at ordinal case23:
60fps, trim/setpts/fps/concat, subtitle layer0 interval[6,7) changed no pixels where
frame6 was required; lavfi60fps/frame6 passed. Result SHA-256:
`713856214d8f395dac8ff693f16b6bc9f687cd99d6953b363313e8e8f10d7217`;
ASS/log/config manifest SHA-256:
`0d51387d176f787a02bb5c566a85269cdfd449fbdb5a2d27d29dd959e5381472`.
This uses pinned FFmpeg8.1.1/Windows, libass0.17.4 and the explicitly pinned Arial file.
The primary FAIL and configuration are archived outside the checkout before scratch
cleanup. Later111/803, adjacent-cue and clipped/rebased cases were not reached in that
run. The follow-up `w69-ass-clock-v3-diagnostic-bd4b5624` repeated the same FAIL.
Result SHA-256 `189184844042196db77bf534379d1b3e65828f883fe4a6d94751418f055981bb`;
ASS/log/clock/raw-RGB manifest SHA-256
`2ce1f0f6e9bc77e9b07d5bbf981808b5618ef1b4e8dcc1b4c5fe1ac85d19e60b`.
Real pre-libass showinfo measured time_base 1/1000000 and frames 5/6/7 integer PTS
83333/100000/116667; frame 6's printed pts_time is 0.1. The retained baseline and
rendered RGB buffers are byte-identical (SHA-256
`56aad8d01f93dc3ed8f764187771dd881666d55ee82ee47dab5b93e328566c3a`).
The double-to-integer millisecond value received inside libass is not measured;
that conversion remains an inference, not a claim that observed PTS was 99999.
The source fingerprint remained e4c78ef455bed8dc2cfb1897cef91666b3dfd81ed242fae8e1d7e1b83246d489,
five identities were terminal, no database started and scratch was clean.
Later 111/803, adjacent and fragment cases still were not reached. No policy seal is
approved and no Linux/Windows equivalence is inferred. W69 clock,
encoding, receipt/OutputSpec corrections remain isolated; integration still needs W66
identities and atomic receipt/manifests/catalog/outbox/success under head/rights/attempt/
lease/cancel fences. Future activation must reject unsealed reuse with a new materialized
payload; current cachev2 does not assert that policy. No positive sidecar/caption claim.

The live-owned EACCES failure, interrupted Windows depth11 run and failed model results
remain preserved. The isolated namespace supervisor and eight Linux supervised suites
remain separate execution gates. W67 independent final pixels/corpus, W70 master,
DigitalOcean deployment and owner acceptance remain pending.

## Historical controlled integration checkpoint — 2026-10-11

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

The subsequent proxy PostgreSQL run `rights-proxy-pg-v3-fcf434ce` exposed a real
publication race: a rights revocation committed while the publisher waited for
its operation lock, but a plain reread retained the older SERIALIZABLE snapshot.
Fresh PostgreSQL time alone prevented expiry, not that revocation. The failed
result remains preserved (SHA-256
`e73d4572221ce6a511e3e2a24b1803c3df98b14458a0a590b48825df513ab3ac`).
The prepared correction locks operation, project and all authoritative source,
music and output artifacts, then refreshes lease/time and rereads. Only exact
P2034 or P2010/40001 conflicts retry the complete transaction, at most three
times. Both resolver paths still require the four real expiry/revocation latches
to pass on the final commit; unit tests do not establish this gate.

The revised staged source passed literal `npm test` in
`rights-fences-unit-v1-49bd2d46`: 2801 tests, 2794 passing, zero failures and seven
identified skips. Result SHA-256
`ab87e861470b3de18e0bd4114bb0dcae38efc3f2a7c4c8e3895ab0d7268a245d`;
fingerprint before/after
`2776c66b85e0a86657e7eb799b4a324778e859e97cd7d766adac173b5c75dc4b`.
All 24 observations completed, 138 process identities were terminal, no database
backends remained, and scratch cleanup passed. This is pre-commit regression
evidence; Linux supervision, PostgreSQL, build and journeys remain separate gates.

CI on `030b7ea8` exposed additional fixture/supervision failures. EACCES reading
an older process environment stopped Quality and perception before their proof;
the new observer excludes only a frozen, rechecked PID/starttime/UID/parent
identity predating the owner, outside every owned/marked descendant tree.
Linux execution remains mandatory. Compose fixtures now explicitly grant their
generated podcast recordings rights and remove an unintended territorial limit
from the generated editor source; the runtime's market and missing-rights gates
remain intact. Dashboard's real project remains `revising`, unknown/blocked and
publicly unexportable. Its final state mechanics use a separately identified
seeded project and test-only approval port, with independent IDs, manifests and
lineage. Neither the seed nor a completed mechanical export is editorial approval.

This adapter is **implemented in isolation, not integrated or approved** for W62. It consumes only explicitly sampled encoded PNG/JPEG frames with strictly increasing nonnegative `ptsMs` and an upstream `sourceSha256` assertion. The caller must establish source bytes, lineage and sampling. The adapter cannot establish coverage between samples, eye visibility, safe subtitle placement, tracking, or identity. Every unsampled interval remains unknown.

`YunetCpuFaceDetector.detect()` in `src/v2/infrastructure/perception/yunet-cpu-face-detector.ts` runs `yunet_cpu_bridge.py` as one owned child per batch. Input is one JSON request on stdin (`apollo-yunet-cpu-v1`) with model/source SHA-256, up to 30 frames, each encoded bytes plus SHA-256 and PTS. Output is one bounded JSON response with per-frame SHA-256, `observed` or `unknown`, reason for unknown, and up to 128 normalized `[left, top, right, bottom]` **XYXY** face boxes with confidence and clipping flag. `observed` with zero boxes means no face in that sampled frame at score >=0.50; any decode, size, inference or protocol failure is unknown/error, never absence. Inputs are at most 5,000,000 encoded bytes each and 20,000,000 per batch. PNG/JPEG dimensions are inspected before OpenCV decode: each axis <=8192 and <=20,000,000 pixels. The decoded dimensions must equal the header. Frames are decoded and processed sequentially. Response cap is 2,000,000 bytes; process timeout is at most 30 seconds. Abort/timeout kills and awaits child closure. Stderr is discarded; no frame pixels or paths are logged.

The Python bridge uses `cv2.FaceDetectorYN_create` with OpenCV DNN CPU, 2 threads and OpenCL disabled, 640×640 canvas, YuNet score 0.50 and NMS 0.30. It maps detector coordinates back to the original frame and clips to `[0,1]`. The model is the MIT-licensed OpenCV Zoo YuNet `face_detection_yunet_2023mar.onnx` pinned to [commit 47534e27](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet), exactly 232589 bytes, SHA-256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`. Python executable, bridge source and OpenCV native `.pyd`/`.so` binary are independently SHA-256 checked before spawn and in the child. OpenCV Python package is pinned to `opencv-python-headless==4.13.0.92`, reporting `cv2.__version__==4.13.0`. Runtime binary hashes are environment-specific; the Windows smoke used `C:/Python314/python.exe` and private `pydeps`, not an implicit production install. Installation is local, outside the repository: `C:/Python314/python.exe -m pip install --target <private-pydeps> --no-deps opencv-python-headless==4.13.0.92 numpy==2.5.1`; the caller supplies absolute paths and actual runtime hashes. No global install, remote inference, or paid API is required.

This code has a real pinned CPU smoke on one synthetic blank frame and malformed headers. That checks bounded execution and the output contract, **not detector accuracy**. Open Images corpus V1–V4 are preserved as failed or incomplete pre-inference acquisition attempts; [V5](./w61-visual-preflight-v5.md) is a separately preregistered CVDF-derivative, Rotation-0 acquisition with no face inference yet. Development/calibration accuracy, sealed holdout, visual video strata and reviewed master remain separate gates. The PostgreSQL/HTTP OCR producer proof is also not facial validation. No product status or TODO completion follows from this adapter alone.
