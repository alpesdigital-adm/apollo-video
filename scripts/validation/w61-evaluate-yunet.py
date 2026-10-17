"""Evaluate frozen, rights-confirmed still images with official OpenCV YuNet API."""

import argparse
import base64
import ctypes
import datetime
import hashlib
import json
import math
import os
import statistics
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np


MODEL_SHA = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
STRATA = ("multiple", "lower", "small", "single", "negative")


def working_set_bytes():
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
    return counters.WorkingSetSize


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
    area_b = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    return inter / (area_a + area_b - inter) if area_a + area_b - inter > 0 else 0.0


def load_frame(item):
    rights = item["attempts"][-1]
    if rights.get("rights") != "original_landing_confirmed" or rights.get("originalPageLicense") != item["metadata"]["License"] or digest(Path(rights["landingPath"])) != rights["landingSha256"]:
        raise ValueError("ORIGINAL_PAGE_RIGHTS_PROOF_MISSING")
    path = Path(item["pixelPath"])
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != item["pixelSha256"]:
        raise ValueError("PIXEL_HASH_MISMATCH")
    try:
        expected_size = int(item["metadata"]["OriginalSize"])
    except ValueError:
        raise ValueError("ORIGINAL_SIZE_UNKNOWN") from None
    if len(data) != expected_size or base64.b64encode(hashlib.md5(data).digest()).decode("ascii") != item["metadata"]["OriginalMD5"]:
        raise ValueError("ORIGINAL_BYTES_METADATA_MISMATCH")
    raw = np.frombuffer(data, dtype=np.uint8)
    # Open Images metadata Rotation is CCW from encoded Flickr bytes; disable EXIF auto-orientation.
    frame = cv2.imdecode(raw, cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
    if frame is None:
        raise ValueError("PIXEL_DECODE_FAILED")
    rotation_text = item["metadata"]["Rotation"].strip()
    if rotation_text in ("", "nan"):
        raise ValueError("ORIENTATION_UNKNOWN")
    try:
        rotation = float(rotation_text)
    except ValueError:
        raise ValueError("ORIENTATION_UNKNOWN") from None
    if rotation == 0:
        pass
    elif rotation == 90:
        frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    elif rotation == 180:
        frame = cv2.rotate(frame, cv2.ROTATE_180)
    elif rotation == 270:
        frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    else:
        raise ValueError("UNSUPPORTED_ROTATION")
    return frame


def infer(detector, frame):
    height, width = frame.shape[:2]
    scale = min(1.0, 640 / max(width, height))
    resized_width, resized_height = round(width * scale), round(height * scale)
    resized = cv2.resize(frame, (resized_width, resized_height), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((640, 640, 3), dtype=np.uint8)
    canvas[:resized_height, :resized_width] = resized
    _, raw_faces = detector.detect(canvas)
    boxes = []
    if raw_faces is not None:
        for face in raw_faces:
            x, y, w, h = map(float, face[:4])
            score = float(face[-1])
            if not math.isfinite(score) or not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
                raise ValueError("MALFORMED_MODEL_BOX")
            boxes.append({"box": [x / scale / width, y / scale / height, (x + w) / scale / width, (y + h) / scale / height], "score": score})
    return boxes


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
    parser.add_argument("set", choices=("development", "calibration", "holdout"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--release-holdout", action="store_true")
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("OUTPUT_ALREADY_EXISTS")
    if args.set == "holdout" and not args.release_holdout:
        raise SystemExit("HOLDOUT_SEALED")
    manifest_sha = digest(args.manifest)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if manifest.get("protocol") != "w61-v3" or manifest.get("status") != "complete_selection":
        raise SystemExit("CORPUS_NOT_FROZEN_OR_INCOMPLETE")
    selected_sets = [manifest["sets"][name]["selected"] for name in ("development", "calibration", "holdout")]
    if any(len(items) != 60 for items in selected_sets):
        raise SystemExit("CORPUS_QUOTA_INCOMPLETE")
    selected_ids = [item["id"] for items in selected_sets for item in items]
    excluded_ids = set(manifest["excludedV1Ids"]) | set(manifest["excludedV2AttemptedIds"])
    if len(selected_ids) != 180 or len(set(selected_ids)) != 180 or any(image_id in excluded_ids for image_id in selected_ids):
        raise SystemExit("CORPUS_ID_OVERLAP")
    pixel_hashes = [item["pixelSha256"] for items in selected_sets for item in items]
    if len(set(pixel_hashes)) != len(pixel_hashes):
        raise SystemExit("CORPUS_PIXEL_SHA_DUPLICATE")
    if digest(args.model) != MODEL_SHA:
        raise SystemExit("MODEL_HASH_MISMATCH")
    cv2.setNumThreads(2)
    cv2.ocl.setUseOpenCL(False)
    rss_initial = working_set_bytes()
    detector = cv2.FaceDetectorYN_create(str(args.model), "", (640, 640), 0.5, 0.3, 5000, cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
    rss_peak = working_set_bytes()
    report = {"protocol": "w61-v3", "manifestSha256": manifest_sha, "modelSha256": MODEL_SHA, "set": args.set, "opencv": cv2.__version__, "pid": os.getpid(), "startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "deadlineSeconds": 120, "runStatus": "complete", "settings": {"input": [640, 640], "longestSide": 640, "upscale": False, "score": 0.5, "nms": 0.3, "topK": 5000, "iou": 0.5, "threads": 2, "backend": "OpenCV DNN CPU", "opencl": False, "rotation": "Open Images CCW metadata applied after EXIF-ignoring decode"}, "items": [], "failures": []}
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
            current_rss = working_set_bytes()
            if current_rss is not None:
                rss_peak = max(rss_peak, current_rss)
            truth = [[float(box["XMin"]), float(box["YMin"]), float(box["XMax"]), float(box["YMax"])] for box in item["boxes"]]
            matches, missed, false = match(predictions, truth)
            report["items"].append({"id": item["id"], "stratum": item["stratum"], "pixelSha256": item["pixelSha256"], "truthCount": len(truth), "predictionCount": len(predictions), "predictions": predictions, "matches": matches, "missed": missed, "falseDetections": false, "preprocessAndInferenceMs": elapsed_ms})
        except Exception as error:
            report["failures"].append({"id": item["id"], "stratum": item["stratum"], "reason": str(error)[:200]})
    selected = manifest["sets"][args.set]["selected"]
    report["overall"] = summarize(report["items"], selected, report["failures"])
    report["strata"] = {name: summarize([entry for entry in report["items"] if entry["stratum"] == name], [entry for entry in selected if entry["stratum"] == name], [entry for entry in report["failures"] if entry["stratum"] == name]) for name in STRATA}
    timings = sorted(entry["preprocessAndInferenceMs"] for entry in report["items"])
    report["resource"] = {"initialRssBytes": rss_initial, "peakRssBytes": rss_peak, "additionalPeakRssBytes": rss_peak - rss_initial if rss_peak is not None and rss_initial is not None else None, "medianMs": statistics.median(timings) if timings else None, "p95Ms": float(np.percentile(timings, 95)) if timings else None, "framesPerSecondObserved": 1000 / statistics.mean(timings) if timings else None, "latencyGate": statistics.median(timings) <= 150 and float(np.percentile(timings, 95)) <= 500 if timings else False, "rssGate": rss_peak - rss_initial <= 512 * 1024 * 1024 if rss_peak is not None and rss_initial is not None else None}
    report["finishedUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "sha256": digest(args.output), "overall": report["overall"], "strata": report["strata"], "failures": report["failures"]}, indent=2))


if __name__ == "__main__":
    main()
