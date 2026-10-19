"""One frozen OpenVINO FP32 face-detector diagnostic on the W61 V5 CVDF corpus."""

import argparse
import datetime
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "2"

import cv2
import numpy as np
import openvino as ov

BASE_PATH = Path(__file__).resolve().parent / "w61-evaluate-yunet-v6-960.py"
BASE_SPEC = importlib.util.spec_from_file_location("w61_v6_eval", BASE_PATH)
BASE = importlib.util.module_from_spec(BASE_SPEC)
BASE_SPEC.loader.exec_module(BASE)

PROTOCOL = "w61-v7-openvino-retail0004-fp32-evaluation"
MANIFEST_SHA = "74cc75cf7a188bca692f51c22cbde1ecd8754bd2ef059a613672bef0acfd9927"
AUDIT_SHA = "e5056b33e4960404f2e19f000185378bae8760dabd083e8e7b3b8b97e5e7b49b"
V5_FREEZE_SHA = "b2197887ad327c2a3b843ab7c3c20c34e564ef7829d43ad473c2ebc22f2344a7"
V5_PLAN_SHA = "081948cbb86ab86f229bac003f8f1060152d5ee4939fe335576f8ced14eaa873"
V5_EVALUATOR_SHA = "a21e3fa5b91976a9eab65df26e3d47f75afb8e4a7fc985424aabc51963193eb1"
V6_EVALUATOR_SHA = "b116938e8f54ce50789c62917b42d2d6b041bcb3f9aa77f752da6e7a71d96a93"
PREREG_SHA = "1c813d9e044b7928e74f35a31040aba0f1d4513792faf33f438adaea2539614b"
SOURCE_FREEZE_SHA = "b80f4d185e3a0ce5791daa5d647f601b8f5a7be3cb44d8a293c9d4c15fb68487"
PYTHON_SHA = "467014615a5255aca450ae88100dd2caf887da87657f00e3c2171ec44a685aec"
OPENCV_SHA = "90034927004e4a4ebf29360480d609c8a8d2ca07c93f8b89dff86399e8534b2a"
WHEEL_SHA = "eab8a6c71210b2596765e3c9ffbdbe05c1d3b279793806e55162befa898a548f"
MODEL_ACQUISITION_SHA = "eb6b9597a6d24ef9efd4f07984ba875882370cf2fa2f58627f0325d33bfe5a08"
WHEEL_ACQUISITION_SHA = "aacf2eceb5282c59490d12ab967b1591fc34871178c03ff0cd97cd1ca86c7c05"
SUPERVISOR_SHA = "4ee69e39feafb1e84b64b1b29ede0766a05d1801701528b00d73139852cff889"
MODEL = {
    "xml": (105340, "1933e7a49baafaf809c4d4c89d6380f018cccdd3be9f96360bc5de3f3008412fbb262236e06fddb3ecdbb5a6a990d010", "90922d199016d18128bdaba488bdb1628fce50efcc81155ede7949cbba3dd979"),
    "bin": (2352984, "a2b4fa6dc07a37fb70d3ff11c207e19c167d45b6db5392e7e759b924df8ce16dbcdb8edff682c38820cc2e54bf6fdabf", "89349ce12dd21c5263fb302cd3ffd4b73c35ea12ed98aff863d03a2cf3a32464"),
}
RUNTIME_FILES = {
    "openvino/_pyopenvino.cp314-win_amd64.pyd": "83a38e99850872420d92c31e401ca42fba9a771697e7b2a79edbb354f1f7e5fc",
    "openvino/libs/openvino.dll": "f3ac0c1f31788efa6886d51ef98de6afcf6798fae5d7f4812f2fe6085fa0f9cb",
    "openvino/libs/openvino_intel_cpu_plugin.dll": "9544add4c8fca1a3d737f3ebc4b8cf6e79d2d51a40331cc1b030776ebf20dce5",
}
ANIMAL_IDS = {
    "7d45a628c403c5d1": "monkey", "6e58d8b2c269091b": "parrot",
    "869c54ed7a443610": "cat", "f215cb000124d954": "cat",
    "808dbc7fccdcfec3": "dog",
}
SETTINGS = {"input": [300, 300], "resize": "direct-INTER_LINEAR", "color": "BGR",
            "layout": "NCHW-float32", "score": 0.5, "iou": 0.5,
            "threads": 2, "streams": 1, "device": "CPU", "extraNms": False}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require_file(path, size, sha384, sha256_expected):
    data = Path(path).read_bytes()
    if (len(data) != size or hashlib.sha384(data).hexdigest() != sha384 or
            hashlib.sha256(data).hexdigest() != sha256_expected):
        raise SystemExit("MODEL_FILE_PROVENANCE_MISMATCH")


def check_sources(args):
    if os.name != "nt":
        raise SystemExit("V7_WINDOWS_RUNTIME_REQUIRED")
    if (sha256(args.manifest) != MANIFEST_SHA or sha256(args.freeze) != V5_FREEZE_SHA or
            sha256(args.plan) != V5_PLAN_SHA or sha256(args.audit) != AUDIT_SHA or
            sha256(BASE_PATH) != V6_EVALUATOR_SHA or sha256(args.preregistration) != PREREG_SHA or
            sha256(args.source_freeze) != SOURCE_FREEZE_SHA):
        raise SystemExit("PREREGISTERED_CORPUS_OR_PROTOCOL_HASH_MISMATCH")
    source_freeze = json.loads(args.source_freeze.read_text(encoding="utf-8"))
    if (source_freeze.get("protocol") != "w61-v7-openvino-retail0004-fp32-preregistration" or
            source_freeze.get("preregistrationSha256") != PREREG_SHA or
            source_freeze.get("manifestSha256") != MANIFEST_SHA or
            source_freeze.get("sourceAuditSha256") != AUDIT_SHA or
            source_freeze.get("detectorCalled") is not False or
            source_freeze.get("holdoutSealed") is not True or
            source_freeze.get("config") != {"model": "face-detection-retail-0004", "precision": "FP32",
                                            "input": [300, 300], "directResize": "INTER_LINEAR", "color": "BGR",
                                            "layout": "NCHW", "score": 0.5, "iou": 0.5,
                                            "cpuThreads": 2, "extraNms": False}):
        raise SystemExit("SOURCE_FREEZE_INVALID")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    audit = json.loads(args.audit.read_text(encoding="utf-8"))
    selected = {name: manifest["sets"][name]["selected"] for name in ("development", "calibration", "holdout")}
    all_items = [item for bucket in selected.values() for item in bucket]
    if (manifest.get("protocol") != "w61-v5" or manifest.get("status") != "complete_selection" or
            manifest.get("freezeSha256") != V5_FREEZE_SHA or manifest.get("planSha256") != V5_PLAN_SHA or
            any(len(bucket) != 60 for bucket in selected.values()) or
            len({item["id"] for item in all_items}) != 180 or
            len({item["mirrorSha256"] for item in all_items}) != 180):
        raise SystemExit("CORPUS_SELECTION_INVALID")
    for bucket in selected.values():
        if any(sum(item["stratum"] == name for item in bucket) != (20 if name == "negative" else 10)
               for name in BASE.STRATA):
            raise SystemExit("CORPUS_QUOTA_INVALID")
    audit_items = {(entry["set"], entry["id"], entry["mirrorSha256"], entry["landingSha256"])
                   for entry in audit.get("items", [])}
    expected_items = {(name, item["id"], item["mirrorSha256"], item["landingSha256"])
                      for name, bucket in selected.items() for item in bucket}
    if (audit.get("protocol") != "w61-v5-source-audit" or audit.get("status") != "complete" or
            audit.get("manifestSha256") != MANIFEST_SHA or audit.get("evaluatorSha256") != V5_EVALUATOR_SHA or
            audit.get("detectorCalled") is not False or audit.get("inferenceCount") != 0 or
            audit.get("decodedPixelShaUnique") is not True or audit.get("failures") or
            len(audit.get("items", [])) != 180 or audit_items != expected_items):
        raise SystemExit("SOURCE_AUDIT_INVALID")
    for suffix, (size, sha384, expected_sha256) in MODEL.items():
        require_file(args.model_dir / f"face-detection-retail-0004.{suffix}", size, sha384, expected_sha256)
    wheel = args.model_dir / "openvino-2026.4.0-22959-cp314-cp314-win_amd64.whl"
    if (wheel.stat().st_size != 84027824 or sha256(wheel) != WHEEL_SHA or
            sha256(args.model_dir / "model-acquisition.json") != MODEL_ACQUISITION_SHA or
            sha256(args.model_dir / "runtime-wheel-acquisition.json") != WHEEL_ACQUISITION_SHA or
            sha256(Path(__file__).resolve().parent / "w61-supervise-evaluator-v5.py") != SUPERVISOR_SHA):
        raise SystemExit("MODEL_RUNTIME_ACQUISITION_OR_SUPERVISOR_MISMATCH")
    if sha256(args.model_dir / "LICENSE") != "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4":
        raise SystemExit("MODEL_LICENSE_MISMATCH")
    if (sha256(sys.executable) != PYTHON_SHA or sha256(BASE.opencv_binary()) != OPENCV_SHA or
            cv2.__version__ != "4.13.0" or importlib.metadata.version("opencv-python-headless") != "4.13.0.92" or
            importlib.metadata.version("openvino") != "2026.4.0" or
            not ov.get_version().startswith("2026.4.0-22959-")):
        raise SystemExit("CPU_RUNTIME_VERSION_MISMATCH")
    runtime_root = args.model_dir / "pydeps"
    if not Path(ov.__file__).resolve().is_relative_to(runtime_root.resolve()):
        raise SystemExit("OPENVINO_NOT_PRIVATE")
    if any(sha256(runtime_root / path) != expected for path, expected in RUNTIME_FILES.items()):
        raise SystemExit("OPENVINO_BINARY_HASH_MISMATCH")
    variant = json.loads(args.variant_freeze.read_text(encoding="utf-8"))
    if (variant.get("protocol") != "w61-v7-openvino-retail0004-fp32-evaluator-freeze" or
            variant.get("sourceFreezeSha256") != SOURCE_FREEZE_SHA or
            variant.get("evaluatorSha256") != sha256(__file__) or
            variant.get("preregistrationSha256") != PREREG_SHA or
            variant.get("modelXmlSha256") != MODEL["xml"][2] or
            variant.get("modelBinSha256") != MODEL["bin"][2] or
            variant.get("runtimeWheelSha256") != WHEEL_SHA or
            variant.get("supervisorSha256") != SUPERVISOR_SHA or
            variant.get("settings") != SETTINGS or
            variant.get("allowedSets") != ["development", "calibration"]):
        raise SystemExit("EVALUATOR_FREEZE_INVALID")
    return manifest


def prepare_frame(frame):
    resized = cv2.resize(frame, (300, 300), interpolation=cv2.INTER_LINEAR)
    blob = np.ascontiguousarray(resized.transpose(2, 0, 1)[None], dtype=np.float32)
    if blob.shape != (1, 3, 300, 300):
        raise ValueError("PREPROCESS_SHAPE_INVALID")
    return blob


def compile_detector(model_dir):
    cv2.setNumThreads(2)
    cv2.ocl.setUseOpenCL(False)
    core = ov.Core()
    model = core.read_model(str(model_dir / "face-detection-retail-0004.xml"),
                            str(model_dir / "face-detection-retail-0004.bin"))
    compiled = core.compile_model(model, "CPU", {"INFERENCE_NUM_THREADS": 2,
                                                   "NUM_STREAMS": "1", "PERFORMANCE_HINT": "LATENCY"})
    if (list(compiled.input(0).shape) != [1, 3, 300, 300] or
            list(compiled.output(0).shape) != [1, 1, 200, 7] or
            compiled.get_property("INFERENCE_NUM_THREADS") != 2 or
            str(compiled.get_property("NUM_STREAMS")) != "1"):
        raise SystemExit("DETECTOR_CPU_CONFIG_INVALID")
    return compiled


def infer(compiled, frame):
    output = np.asarray(compiled([prepare_frame(frame)])[compiled.output(0)])
    if output.shape != (1, 1, 200, 7):
        raise ValueError("DETECTOR_OUTPUT_SHAPE_INVALID")
    boxes = []
    for row in output[0, 0]:
        image_id, label, score, x1, y1, x2, y2 = map(float, row)
        if image_id == -1:
            continue
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("DETECTOR_SCORE_INVALID")
        if score < 0.5:
            continue
        if (image_id != 0 or label != 1 or
                not all(math.isfinite(v) for v in (x1, y1, x2, y2)) or
                not 0 <= x1 < x2 <= 1 or not 0 <= y1 < y2 <= 1):
            raise ValueError("DETECTOR_FACE_BOX_INVALID")
        boxes.append({"box": [x1, y1, x2, y2], "score": score, "clipped": False})
    return boxes


def run(args):
    if args.output.exists():
        raise SystemExit("OUTPUT_ALREADY_EXISTS")
    manifest = check_sources(args)
    compiled = compile_detector(args.model_dir)
    evaluator_sha = sha256(__file__)
    if args.config_check:
        checks = []
        for name in ("development", "calibration"):
            item = manifest["sets"][name]["selected"][0]
            frame = BASE.load_frame(item)
            blob = prepare_frame(frame)
            checks.append({"set": name, "id": item["id"], "sourceShape": [frame.shape[1], frame.shape[0]],
                           "modelInputShape": list(blob.shape), "mirrorSha256": item["mirrorSha256"]})
        report = {"protocol": "w61-v7-retail0004-config-check", "status": "passed",
                  "modelLoadedWithoutInference": True, "detectorCalled": False, "inferenceCount": 0,
                  "evaluatorSha256": evaluator_sha, "variantFreezeSha256": sha256(args.variant_freeze),
                  "manifestSha256": MANIFEST_SHA, "device": "CPU", "checks": checks}
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": "passed", "outputSha256": sha256(args.output), "detectorCalled": False}))
        return
    selected = manifest["sets"][args.set]["selected"]
    rss_initial = BASE.working_set_bytes()
    rss_peak = BASE.working_set_bytes(peak=True)
    report = {"protocol": PROTOCOL, "set": args.set, "pid": os.getpid(),
              "startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "manifestSha256": MANIFEST_SHA, "sourceAuditSha256": AUDIT_SHA,
              "sourceFreezeSha256": SOURCE_FREEZE_SHA, "variantFreezeSha256": sha256(args.variant_freeze),
              "evaluatorSha256": evaluator_sha, "preregistrationSha256": PREREG_SHA,
              "modelXmlSha256": MODEL["xml"][2], "modelBinSha256": MODEL["bin"][2],
              "openvinoVersion": ov.get_version(), "settings": SETTINGS,
              "runStatus": "complete", "items": [], "failures": []}
    measured = []
    started_benchmark = time.monotonic()
    try:
        frame = BASE.load_frame(selected[0])
        for index in range(33):
            if time.monotonic() - started_benchmark >= 30:
                raise TimeoutError("RESOURCE_SPIKE_30_SECOND_DEADLINE")
            started = time.perf_counter()
            infer(compiled, frame)
            elapsed = 1000 * (time.perf_counter() - started)
            rss_peak = max(rss_peak, BASE.working_set_bytes(peak=True))
            if index >= 3:
                measured.append(elapsed)
        if time.monotonic() - started_benchmark > 30:
            raise TimeoutError("RESOURCE_SPIKE_30_SECOND_DEADLINE")
        report["resourceBenchmark"] = {"imageId": selected[0]["id"], "warmups": 3,
            "measuredRuns": 30, "medianMs": statistics.median(measured),
            "p95Ms": float(np.percentile(measured, 95)),
            "elapsedSeconds": time.monotonic() - started_benchmark,
            "latencyGate": statistics.median(measured) <= 150 and float(np.percentile(measured, 95)) <= 500}
    except Exception as error:
        report["resourceBenchmark"] = {"imageId": selected[0]["id"], "warmups": 3,
            "measuredRuns": len(measured), "elapsedSeconds": time.monotonic() - started_benchmark,
            "latencyGate": False, "failure": str(error)[:200]}
    deadline = time.monotonic() + 120
    for item in selected:
        if time.monotonic() >= deadline:
            report["runStatus"] = "partial_timeout"
            done = {entry["id"] for entry in report["items"] + report["failures"]}
            report["failures"].extend({"id": rest["id"], "stratum": rest["stratum"],
                                       "reason": "RUN_DEADLINE_UNEVALUATED"}
                                      for rest in selected if rest["id"] not in done)
            break
        try:
            frame = BASE.load_frame(item)
            started = time.perf_counter()
            predictions = infer(compiled, frame)
            elapsed = 1000 * (time.perf_counter() - started)
            rss_peak = max(rss_peak, BASE.working_set_bytes(peak=True))
            truth = [[float(box[key]) for key in ("XMin", "YMin", "XMax", "YMax")] for box in item["boxes"]]
            matches, missed, false = BASE.match(predictions, truth)
            report["items"].append({"id": item["id"], "stratum": item["stratum"],
                "mirrorSha256": item["mirrorSha256"], "truthCount": len(truth),
                "predictionCount": len(predictions), "predictions": predictions,
                "matches": matches, "missed": missed, "falseDetections": false,
                "preprocessAndInferenceMs": elapsed})
        except Exception as error:
            report["failures"].append({"id": item["id"], "stratum": item["stratum"], "reason": str(error)[:200]})
    report["overall"] = BASE.summarize(report["items"], selected, report["failures"])
    report["strata"] = {name: BASE.summarize(
        [entry for entry in report["items"] if entry["stratum"] == name],
        [entry for entry in selected if entry["stratum"] == name],
        [entry for entry in report["failures"] if entry["stratum"] == name]) for name in BASE.STRATA}
    report["animalDiagnostic"] = [{"id": item["id"], "animal": ANIMAL_IDS[item["id"]],
        "set": args.set, "predictionCount": next((entry["predictionCount"] for entry in report["items"]
                                                    if entry["id"] == item["id"]), None),
        "failed": any(entry["id"] == item["id"] for entry in report["failures"])}
        for item in selected if item["id"] in ANIMAL_IDS]
    timings = sorted(entry["preprocessAndInferenceMs"] for entry in report["items"])
    report["resource"] = {"initialRssBytes": rss_initial, "peakRssBytes": rss_peak,
        "peakMethod": "Windows GetProcessMemoryInfo.PeakWorkingSetSize; includes process import high-water",
        "additionalPeakRssBytes": rss_peak - rss_initial,
        "additionalRssGate": rss_peak - rss_initial <= 512 * 1024 * 1024,
        "totalPeakRssWithin512MiBDiagnostic": rss_peak <= 512 * 1024 * 1024,
        "medianPerImageMs": statistics.median(timings) if timings else None,
        "p95PerImageMs": float(np.percentile(timings, 95)) if timings else None,
        "perImageLatencyDiagnosticOnly": True}
    report["finishedUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["runStatus"], "outputSha256": sha256(args.output),
                      "overall": report["overall"], "failures": report["failures"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("model_dir", type=Path)
    parser.add_argument("set", choices=("development", "calibration"))
    parser.add_argument("--freeze", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--preregistration", type=Path, required=True)
    parser.add_argument("--source-freeze", type=Path, required=True)
    parser.add_argument("--variant-freeze", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--config-check", action="store_true")
    run(parser.parse_args())
