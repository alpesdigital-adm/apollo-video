"""Evaluate the frozen CVDF V5 corpus with one preregistered YuNet 960 CPU variant."""

import argparse
import ctypes
import datetime
import hashlib
import importlib.metadata
import importlib.util
import io
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
from PIL import Image


MODEL_SHA = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
MODEL_SOURCE_COMMIT = "47534e27c9851bb1128ccc0102f1145e27f23f98"
V5_EVALUATOR_SHA = "a21e3fa5b91976a9eab65df26e3d47f75afb8e4a7fc985424aabc51963193eb1"
INPUT_SIDE = 960
EVALUATION_PROTOCOL = "w61-v6-yunet960-cvdf-evaluation"
STRATA = ("multiple", "lower", "small", "single", "negative")
SPEC = importlib.util.spec_from_file_location("w61_fetch", Path(__file__).resolve().parent / "w61-fetch-corpus.py")
FETCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FETCH)


def working_set_bytes(peak=False):
    if os.name != "nt":
        return None
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    counters = Counters()
    counters.cb = ctypes.sizeof(Counters)
    get_current = ctypes.windll.kernel32.GetCurrentProcess
    get_current.restype = ctypes.c_void_p
    get_info = ctypes.windll.psapi.GetProcessMemoryInfo
    get_info.argtypes = (ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong)
    get_info.restype = ctypes.c_int
    if not get_info(get_current(), ctypes.byref(counters), counters.cb):
        raise OSError("GetProcessMemoryInfo failed")
    return counters.PeakWorkingSetSize if peak else counters.WorkingSetSize


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def opencv_binary():
    binaries = [path for pattern in ("*.pyd", "*.so") for path in Path(cv2.__file__).parent.glob(pattern)]
    if len(binaries) != 1:
        raise SystemExit("OPENCV_BINARY_AMBIGUOUS")
    return binaries[0]


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
    area_b = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    return inter / (area_a + area_b - inter) if area_a + area_b - inter > 0 else 0.0


def load_frame(item):
    metadata = item["metadata"]
    expected_url = f"https://open-images-dataset.s3.amazonaws.com/{item['sourceSplit']}/{item['id']}.jpg"
    if (item.get("status") != "eligible" or item.get("mirrorUrl") != expected_url or
        item.get("mirrorHttp") != 200 or not (item.get("mirrorContentType") or "").startswith("image/jpeg")):
        raise ValueError("MIRROR_SOURCE_NOT_VERIFIED")
    if (item.get("rights") != "original_landing_confirmed" or
        item.get("landingUrl") != metadata["OriginalLandingURL"] or
        item.get("originalPageLicense") != metadata["License"] or
        digest(Path(item["landingPath"])) != item["landingSha256"] or
        FETCH.page_photo_license(Path(item["landingPath"]).read_text(encoding="utf-8", errors="replace"),
                                 item["landingUrl"]) != metadata["License"]):
        raise ValueError("ORIGINAL_PAGE_RIGHTS_PROOF_MISSING")
    path = Path(item["mirrorPath"])
    data = path.read_bytes()
    if (hashlib.sha256(data).hexdigest() != item["mirrorSha256"] or
        len(data) != item["mirrorBytes"] or len(data) > 5_000_000 or
        (item.get("mirrorContentLength") and int(item["mirrorContentLength"]) != len(data))):
        raise ValueError("MIRROR_BYTES_HASH_OR_SIZE_MISMATCH")
    if (hashlib.md5(data).hexdigest() != item["mirrorMd5Hex"] or
        item.get("mirrorEtagRaw") != f'"{item["mirrorMd5Hex"]}"'):
        raise ValueError("MIRROR_ETAG_MD5_MISMATCH")
    Image.MAX_IMAGE_PIXELS = 4_000_000
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "JPEG" or image.getexif().get(274) not in (None, 1) or list(image.size) != [item["mirrorWidth"], item["mirrorHeight"]]:
            raise ValueError("MIRROR_JPEG_ORIENTATION_OR_SIZE_INVALID")
        image.verify()
    if item.get("aspectEvidence") == "cached_original_compared":
        original = item.get("originalDimensions")
        if (not isinstance(original, list) or len(original) != 2 or
            not all(isinstance(value, int) and value > 0 for value in original) or
            abs(item["mirrorWidth"] / item["mirrorHeight"] - original[0] / original[1]) > 0.01):
            raise ValueError("MIRROR_ORIGINAL_ASPECT_MISMATCH")
    elif item.get("aspectEvidence") != "aspect_original_unverified" or item.get("originalDimensions") is not None:
        raise ValueError("MIRROR_ASPECT_EVIDENCE_INVALID")
    if float(metadata["Rotation"]) != 0:
        raise ValueError("ROTATION_NOT_ZERO")
    raw = np.frombuffer(data, dtype=np.uint8)
    # V5 mirror is Rotation=0 and neutral EXIF; never auto-rotate twice.
    frame = cv2.imdecode(raw, cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
    if frame is None or [frame.shape[1], frame.shape[0]] != [item["mirrorWidth"], item["mirrorHeight"]]:
        raise ValueError("MIRROR_DECODE_OR_DIMENSIONS_INVALID")
    return frame


def prepare_frame(frame):
    height, width = frame.shape[:2]
    scale = min(1.0, INPUT_SIDE / max(width, height))
    resized_width, resized_height = round(width * scale), round(height * scale)
    resized = cv2.resize(frame, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((INPUT_SIDE, INPUT_SIDE, 3), dtype=np.uint8)
    canvas[:resized_height, :resized_width] = resized
    return canvas, scale


def infer(detector, frame):
    height, width = frame.shape[:2]
    canvas, scale = prepare_frame(frame)
    _, raw_faces = detector.detect(canvas)
    boxes = []
    if raw_faces is not None:
        for face in raw_faces:
            x, y, w, h = map(float, face[:4])
            score = float(face[-1])
            if not math.isfinite(score) or not 0.5 <= score <= 1 or not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
                raise ValueError("MALFORMED_MODEL_BOX")
            x1, y1, x2, y2 = x / scale / width, y / scale / height, (x + w) / scale / width, (y + h) / scale / height
            if x2 <= 0 or y2 <= 0 or x1 >= 1 or y1 >= 1:
                raise ValueError("OUTSIDE_FRAME_DETECTION")
            if len(boxes) >= 128:
                raise ValueError("FACE_BOX_COUNT_LIMIT")
            boxes.append({"box": [max(0.0, x1), max(0.0, y1), min(1.0, x2), min(1.0, y2)],
                          "score": score, "clipped": x1 < 0 or y1 < 0 or x2 > 1 or y2 > 1})
    return boxes


def create_detector(model_path):
    cv2.setNumThreads(2)
    cv2.ocl.setUseOpenCL(False)
    detector = cv2.FaceDetectorYN_create(str(model_path), "", (INPUT_SIDE, INPUT_SIDE),
                                          0.5, 0.3, 5000,
                                          cv2.dnn.DNN_BACKEND_OPENCV,
                                          cv2.dnn.DNN_TARGET_CPU)
    if tuple(detector.getInputSize()) != (INPUT_SIDE, INPUT_SIDE):
        raise SystemExit("V6_DETECTOR_INPUT_SIZE_MISMATCH")
    return detector


def match(predicted, truth):
    pairs = sorted(((iou(p["box"], t), pi, ti) for pi, p in enumerate(predicted) for ti, t in enumerate(truth)), reverse=True)
    used_predictions, used_truth = set(), set()
    matches = []
    for overlap, pi, ti in pairs:
        if overlap < 0.5 or pi in used_predictions or ti in used_truth:
            continue
        used_predictions.add(pi)
        used_truth.add(ti)
        matches.append({"prediction": pi, "truth": ti, "iou": overlap})
    return matches, len(truth) - len(matches), len(predicted) - len(matches)


def summarize(items, selected, failures):
    faces = sum(len(entry["boxes"]) for entry in selected)
    matched = sum(len(entry["matches"]) for entry in items)
    false = sum(entry["falseDetections"] for entry in items)
    negatives = [entry for entry in items if entry["stratum"] == "negative"]
    selected_negatives = [entry for entry in selected if entry["stratum"] == "negative"]
    failed_negative_ids = {entry["id"] for entry in failures if entry["stratum"] == "negative"}
    overlaps = [match["iou"] for entry in items for match in entry["matches"]]
    bins = []
    total_predictions = sum(entry["predictionCount"] for entry in items)
    ece = 0.0
    for lower in (0.5, 0.6, 0.7, 0.8, 0.9):
        upper = round(lower + 0.1, 1)
        scored = [(prediction["score"], index in {match["prediction"] for match in entry["matches"]}) for entry in items for index, prediction in enumerate(entry["predictions"]) if lower <= prediction["score"] < upper or lower == 0.9 and prediction["score"] == 1.0]
        count = len(scored)
        accuracy = sum(ok for _, ok in scored) / count if count else None
        confidence = sum(score for score, _ in scored) / count if count else None
        bins.append({"range": [lower, round(lower + 0.1, 1)], "count": count, "accuracy": accuracy, "meanConfidence": confidence})
        if count and total_predictions:
            ece += count / total_predictions * abs(accuracy - confidence)
    wilson = None
    if faces:
        z = 1.96
        p = matched / faces
        wilson = (p + z*z/(2*faces) - z*math.sqrt(p*(1-p)/faces + z*z/(4*faces*faces))) / (1 + z*z/faces)
    false_positive_negatives = sum(entry["predictionCount"] > 0 for entry in negatives)
    return {"selectedImages": len(selected), "evaluatedImages": len(items), "failedImages": len(failures), "completeness": len(items) / len(selected) if selected else None, "faces": faces, "matched": matched, "missedIncludingFailed": faces - matched, "falseDetectionsObserved": false, "recallIncludingFailed": matched / faces if faces else None, "recallWilson95Lower": wilson, "precisionObserved": matched / (matched + false) if matched + false else None, "medianMatchedIoU": float(np.median(overlaps)) if overlaps else None, "p95MatchedIoU": float(np.percentile(overlaps, 95)) if overlaps else None, "confidenceBinsObserved": bins, "eceObserved": ece if total_predictions else None, "negativeImageFalsePositiveRateObserved": false_positive_negatives / len(negatives) if negatives else None, "negativeImageFalsePositiveRateUpper": (false_positive_negatives + len(failed_negative_ids)) / len(selected_negatives) if selected_negatives else None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("model", type=Path)
    parser.add_argument("--model-license", type=Path, required=True)
    parser.add_argument("set", choices=("development", "calibration"))
    parser.add_argument("--freeze", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--config-check", action="store_true")
    parser.add_argument("--variant-freeze", type=Path, required=True)
    parser.add_argument("--variant-preregistration", type=Path, required=True)
    parser.add_argument("--source-audit-record", type=Path)
    parser.add_argument("--expected-source-audit-sha256")
    parser.add_argument("--expected-python-sha256", required=True)
    parser.add_argument("--expected-opencv-binary-sha256", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("OUTPUT_ALREADY_EXISTS")
    manifest_sha = digest(args.manifest)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    freeze = json.loads(args.freeze.read_text(encoding="utf-8"))
    if (manifest.get("protocol") != "w61-v5" or manifest.get("status") != "complete_selection" or
        manifest.get("freezeSha256") != digest(args.freeze) or
        manifest.get("planSha256") != digest(args.plan) or
        freeze.get("selectorSha256") != digest(Path(__file__).resolve().parent / "w61-freeze-openimages-v5.py") or
        freeze.get("fetcherSha256") != digest(Path(__file__).resolve().parent / "w61-fetch-corpus.py") or
        freeze.get("planSha256") != digest(args.plan)):
        raise SystemExit("CORPUS_NOT_FROZEN_OR_INCOMPLETE")
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    selected_sets = [manifest["sets"][name]["selected"] for name in ("development", "calibration", "holdout")]
    if any(len(items) != 60 for items in selected_sets):
        raise SystemExit("CORPUS_QUOTA_INCOMPLETE")
    for bucket in ("development", "calibration", "holdout"):
        selected = manifest["sets"][bucket]["selected"]
        source_split = plan["sets"][bucket]["sourceSplit"]
        if source_split not in ("validation", "test") or manifest["sets"][bucket]["sourceSplit"] != source_split:
            raise SystemExit("CORPUS_SPLIT_PROVENANCE_INVALID")
        attempted = {item["id"]: item for item in manifest["sets"][bucket]["attempted"]}
        for name in STRATA:
            chosen = [item for item in selected if item["stratum"] == name]
            if len(chosen) != (20 if name == "negative" else 10):
                raise SystemExit("CORPUS_STRATUM_QUOTA_INCOMPLETE")
            candidates = plan["sets"][bucket]["candidates"][name]
            ranked_ids = [item["id"] for item in candidates]
            chosen_ids = {item["id"] for item in chosen}
            if (any(item["id"] not in ranked_ids or item["id"] not in attempted or
                    item["sourceSplit"] != source_split or item["metadata"]["Subset"] != source_split or
                    item["metadata"]["ImageID"] != item["id"] or
                    item["metadata"] != candidates[ranked_ids.index(item["id"])]["metadata"] or
                    item["boxes"] != candidates[ranked_ids.index(item["id"])]["boxes"] for item in chosen) or
                [ranked_ids.index(item["id"]) for item in chosen] != sorted(ranked_ids.index(item["id"]) for item in chosen) or
                any(image_id not in attempted or
                    attempted[image_id].get("status") == "eligible" and image_id not in chosen_ids
                    for image_id in ranked_ids[:ranked_ids.index(chosen[-1]["id"]) + 1])):
                raise SystemExit("CORPUS_SELECTION_ORDER_OR_PROVENANCE_INVALID")
    selected_ids = [item["id"] for items in selected_sets for item in items]
    if len(selected_ids) != 180 or len(set(selected_ids)) != 180:
        raise SystemExit("CORPUS_ID_OVERLAP")
    pixel_hashes = [item["mirrorSha256"] for items in selected_sets for item in items]
    if len(set(pixel_hashes)) != len(pixel_hashes):
        raise SystemExit("CORPUS_PIXEL_SHA_DUPLICATE")
    if digest(args.model) != MODEL_SHA:
        raise SystemExit("MODEL_HASH_MISMATCH")
    python_sha = digest(Path(sys.executable))
    opencv_sha = digest(opencv_binary())
    if (python_sha != args.expected_python_sha256 or
        opencv_sha != args.expected_opencv_binary_sha256 or
        cv2.__version__ != "4.13.0" or
        importlib.metadata.version("opencv-python-headless") != "4.13.0.92"):
        raise SystemExit("CPU_RUNTIME_HASH_OR_VERSION_MISMATCH")
    evaluator_sha = digest(Path(__file__))
    if not args.source_audit_record or not args.expected_source_audit_sha256:
        raise SystemExit("SOURCE_AUDIT_REQUIRED")
    if digest(args.source_audit_record) != args.expected_source_audit_sha256:
        raise SystemExit("SOURCE_AUDIT_HASH_MISMATCH")
    source_audit = json.loads(args.source_audit_record.read_text(encoding="utf-8"))
    expected_audit_items = {(bucket, item["id"], item["mirrorSha256"], item["landingSha256"])
                            for bucket, selected in zip(("development", "calibration", "holdout"), selected_sets)
                            for item in selected}
    if (source_audit.get("protocol") != "w61-v5-source-audit" or
        source_audit.get("status") != "complete" or
        source_audit.get("manifestSha256") != manifest_sha or
        source_audit.get("evaluatorSha256") != V5_EVALUATOR_SHA or
        source_audit.get("detectorCalled") is not False or source_audit.get("inferenceCount") != 0 or
        source_audit.get("decodedPixelShaUnique") is not True or
        len(source_audit.get("items", [])) != 180 or source_audit.get("failures") or
        len({entry["decodedPixelsSha256"] for entry in source_audit["items"]}) != 180 or
        {(entry["set"], entry["id"], entry["mirrorSha256"], entry["landingSha256"])
         for entry in source_audit["items"]} != expected_audit_items):
        raise SystemExit("SOURCE_AUDIT_INVALID")
    variant = json.loads(args.variant_freeze.read_text(encoding="utf-8"))
    repository = Path(__file__).resolve().parents[2]
    if (variant.get("protocol") != "w61-v6-yunet960-freeze" or
        variant.get("manifestSha256") != manifest_sha or
        variant.get("v5SourceAuditSha256") != args.expected_source_audit_sha256 or
        variant.get("v5SourceAuditEvaluatorSha256") != V5_EVALUATOR_SHA or
        variant.get("v5FreezeSha256") != digest(args.freeze) or
        variant.get("v5PlanSha256") != digest(args.plan) or
        variant.get("evaluatorSha256") != evaluator_sha or
        variant.get("preregistrationSha256") != digest(args.variant_preregistration) or
        variant.get("modelSha256") != MODEL_SHA or
        variant.get("modelLicenseSha256") != digest(args.model_license) or
        variant.get("modelSourceCommit") != MODEL_SOURCE_COMMIT or
        variant.get("pythonSha256") != python_sha or
        variant.get("opencvBinarySha256") != opencv_sha or
        variant.get("supervisorSha256") != digest(Path(__file__).resolve().parent / "w61-supervise-evaluator-v5.py") or
        variant.get("bridgeSha256") != digest(repository / "src/v2/infrastructure/perception/yunet_cpu_bridge.py") or
        variant.get("adapterSha256") != digest(repository / "src/v2/infrastructure/perception/yunet-cpu-face-detector.ts") or
        variant.get("allowedSets") != ["development", "calibration"] or
        variant.get("settings") != {"input": [960, 960], "longestSide": 960,
            "upscale": False, "resize": "INTER_AREA", "canvas": "top-left-zero-pad",
            "score": 0.5, "nms": 0.3, "topK": 5000, "iou": 0.5,
            "threads": 2, "backend": "OpenCV DNN CPU"}):
        raise SystemExit("V6_PREREGISTRATION_FREEZE_INVALID")
    if args.config_check:
        detector = create_detector(args.model)
        checks = []
        for bucket in ("development", "calibration"):
            item = manifest["sets"][bucket]["selected"][0]
            frame = load_frame(item)
            canvas, scale = prepare_frame(frame)
            if (canvas.shape != (INPUT_SIDE, INPUT_SIDE, 3) or
                not 0 < scale < 1 or
                max(frame.shape[:2]) <= INPUT_SIDE):
                raise SystemExit("V6_PREPROCESS_CONFIG_SMOKE_FAILED")
            checks.append({"set": bucket, "id": item["id"],
                           "sourceShape": [int(frame.shape[1]), int(frame.shape[0])],
                           "canvasShape": [int(canvas.shape[1]), int(canvas.shape[0])],
                           "scale": scale, "mirrorSha256": item["mirrorSha256"]})
        report = {"protocol": "w61-v6-yunet960-config-check", "detectorCalled": False,
                  "inferenceCount": 0, "variantFreezeSha256": digest(args.variant_freeze),
                  "evaluatorSha256": evaluator_sha, "manifestSha256": manifest_sha,
                  "modelLoadedWithoutDetection": True,
                  "detectorInputSize": list(detector.getInputSize()),
                  "checks": checks, "status": "passed"}
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": "passed", "outputSha256": digest(args.output),
                          "detectorCalled": False, "checks": len(checks)}))
        return
    rss_initial = working_set_bytes()
    detector = create_detector(args.model)
    rss_peak = working_set_bytes(peak=True)
    report = {"protocol": EVALUATION_PROTOCOL, "manifestSha256": manifest_sha,
              "freezeSha256": digest(args.freeze), "planSha256": digest(args.plan),
              "evaluatorSha256": evaluator_sha, "sourceAuditSha256": args.expected_source_audit_sha256,
              "variantFreezeSha256": digest(args.variant_freeze),
              "preregistrationSha256": digest(args.variant_preregistration),
              "modelSha256": MODEL_SHA,
              "set": args.set, "opencv": cv2.__version__, "opencvPackage": "4.13.0.92",
              "pythonSha256": python_sha, "opencvBinarySha256": opencv_sha, "pid": os.getpid(),
              "startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "deadlineSeconds": 120, "runStatus": "complete",
              "settings": {"input": [960, 960], "longestSide": 960, "upscale": False,
                           "resize": "INTER_AREA", "canvas": "top-left-zero-pad",
                           "score": 0.5, "nms": 0.3, "topK": 5000, "iou": 0.5,
                           "threads": 2, "backend": "OpenCV DNN CPU", "opencl": False,
                           "source": "Open Images CVDF resampled JPEG; Rotation 0 and neutral EXIF"},
              "items": [], "failures": []}
    benchmark_times = []
    benchmark_started = time.monotonic()
    try:
        benchmark_item = manifest["sets"][args.set]["selected"][0]
        benchmark_frame = load_frame(benchmark_item)
        for index in range(33):
            if time.monotonic() - benchmark_started >= 30:
                raise TimeoutError("RESOURCE_SPIKE_30_SECOND_DEADLINE")
            started = time.perf_counter()
            infer(detector, benchmark_frame)
            elapsed_ms = (time.perf_counter() - started) * 1000
            current_rss = working_set_bytes(peak=True)
            if current_rss is not None:
                rss_peak = max(rss_peak, current_rss)
            if index >= 3:
                benchmark_times.append(elapsed_ms)
        if time.monotonic() - benchmark_started > 30:
            raise TimeoutError("RESOURCE_SPIKE_30_SECOND_DEADLINE")
        report["resourceBenchmark"] = {"imageId": benchmark_item["id"], "warmups": 3,
            "measuredRuns": 30, "medianMs": statistics.median(benchmark_times),
            "p95Ms": float(np.percentile(benchmark_times, 95)),
            "elapsedSeconds": time.monotonic() - benchmark_started,
            "latencyGate": statistics.median(benchmark_times) <= 150 and
                           float(np.percentile(benchmark_times, 95)) <= 500}
    except Exception as error:
        report["resourceBenchmark"] = {"imageId": manifest["sets"][args.set]["selected"][0]["id"],
                                       "warmups": 3, "measuredRuns": len(benchmark_times),
                                       "elapsedSeconds": time.monotonic() - benchmark_started,
                                       "latencyGate": False, "failure": str(error)[:200]}
    deadline = time.monotonic() + 120
    for item in manifest["sets"][args.set]["selected"]:
        if time.monotonic() >= deadline:
            report["runStatus"] = "partial_timeout"
            report["failures"].extend({"id": remaining["id"], "stratum": remaining["stratum"], "reason": "RUN_DEADLINE_UNEVALUATED"} for remaining in manifest["sets"][args.set]["selected"] if remaining["id"] not in {entry["id"] for entry in report["items"]} and remaining["id"] not in {entry["id"] for entry in report["failures"]})
            break
        try:
            frame = load_frame(item)
            started = time.perf_counter()
            predictions = infer(detector, frame)
            elapsed_ms = (time.perf_counter() - started) * 1000
            current_rss = working_set_bytes(peak=True)
            if current_rss is not None:
                rss_peak = max(rss_peak, current_rss)
            truth = [[float(box["XMin"]), float(box["YMin"]), float(box["XMax"]), float(box["YMax"])] for box in item["boxes"]]
            matches, missed, false = match(predictions, truth)
            report["items"].append({"id": item["id"], "stratum": item["stratum"], "mirrorSha256": item["mirrorSha256"], "truthCount": len(truth), "predictionCount": len(predictions), "predictions": predictions, "matches": matches, "missed": missed, "falseDetections": false, "preprocessAndInferenceMs": elapsed_ms})
        except Exception as error:
            report["failures"].append({"id": item["id"], "stratum": item["stratum"], "reason": str(error)[:200]})
    selected = manifest["sets"][args.set]["selected"]
    report["overall"] = summarize(report["items"], selected, report["failures"])
    report["strata"] = {name: summarize([entry for entry in report["items"] if entry["stratum"] == name], [entry for entry in selected if entry["stratum"] == name], [entry for entry in report["failures"] if entry["stratum"] == name]) for name in STRATA}
    timings = sorted(entry["preprocessAndInferenceMs"] for entry in report["items"])
    report["resource"] = {"initialRssBytes": rss_initial, "peakRssBytes": rss_peak,
                          "peakMethod": "Windows GetProcessMemoryInfo.PeakWorkingSetSize; includes process import high-water",
                          "additionalPeakRssBytes": rss_peak - rss_initial if rss_peak is not None and rss_initial is not None else None,
                          "medianPerImageMs": statistics.median(timings) if timings else None,
                          "p95PerImageMs": float(np.percentile(timings, 95)) if timings else None,
                          "framesPerSecondObserved": 1000 / statistics.mean(timings) if timings else None,
                          "perImageLatencyDiagnosticOnly": True,
                          "additionalRssGate": rss_peak - rss_initial <= 512 * 1024 * 1024 if rss_peak is not None and rss_initial is not None else None,
                          "totalPeakRssWithin512MiBDiagnostic": rss_peak <= 512 * 1024 * 1024 if rss_peak is not None else None}
    report["finishedUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "sha256": digest(args.output), "overall": report["overall"], "strata": report["strata"], "failures": report["failures"]}, indent=2))


if __name__ == "__main__":
    main()
