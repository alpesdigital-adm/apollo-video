"""Select V4 Open Images faces, reusing only byte-verified prior acquisition evidence."""

import base64
import binascii
import csv
import hashlib
import importlib.util
import io
import json
import os
import sys
import time
import datetime
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image
import cv2
import numpy as np


BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("w61_fetch", BASE / "w61-fetch-corpus.py")
fetch_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_module)

MID = "/m/0dzct"
LICENSES = {"https://creativecommons.org/licenses/by/2.0/", "https://creativecommons.org/licenses/by/4.0/"}
SOURCE_ROOT = Path(sys.argv[1])
V1_PATH = Path(sys.argv[2])
V2_PATH = Path(sys.argv[3])
V3_PATH = Path(sys.argv[4])
OUTPUT = Path(sys.argv[5])
PIXELS = OUTPUT.parent / "corpus-v4"
EXPECTED_V1_SHA = "c8184f6b71552edf566b9d8dff51b3d1e76b76bba3aa581a43d919ba6e84fc5e"
EXPECTED_V2_SHA = "d8d9edeccb714f968aa76ae4931edcb97309fe289add1ee47d59cce99b17e3d1"
EXPECTED_V3_SHA = "00d5729f2a1dc5ceb21277e78b7b67887e1adfc153f34056ecc5f03b09e7e4d6"
CACHE = {}

FILES = {
    "validation": {"boxes": "validation-annotations-bbox.csv", "labels": "oidv7-val-annotations-human-imagelabels.csv", "metadata": "validation-images-with-rotation.csv"},
    "test": {"boxes": "test-annotations-bbox.csv", "labels": "oidv7-test-annotations-human-imagelabels.csv", "metadata": "test-images-with-rotation.csv"},
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(path):
    with path.open(newline="", encoding="utf-8") as source:
        yield from csv.DictReader(source)


def box_ok(row):
    try:
        x1, x2, y1, y2 = (float(row[k]) for k in ("XMin", "XMax", "YMin", "YMax"))
    except (ValueError, KeyError):
        return False
    return 0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1 and row["Source"] in ("xclick", "activemil") and row["IsGroupOf"] == "0" and row["IsDepiction"] == "0"


def stratum(boxes):
    if len(boxes) >= 2:
        return "multiple"
    if len(boxes) != 1:
        return None
    box = boxes[0]
    center_y = (float(box["YMin"]) + float(box["YMax"])) / 2
    area = (float(box["XMax"]) - float(box["XMin"])) * (float(box["YMax"]) - float(box["YMin"]))
    return "lower" if center_y >= 0.65 else "small" if area <= 0.02 else "single"


def rank(ids, bucket, name):
    return sorted(ids, key=lambda image_id: (hashlib.sha256(f"w61-v3|{bucket}|{name}|{image_id}".encode()).digest(), image_id))


def metadata_ok(row):
    if row["License"].strip() not in LICENSES or not row["OriginalURL"].startswith("https://") or not row["OriginalLandingURL"].startswith("https://"):
        return False
    try:
        if float(row["Rotation"]) not in (0, 90, 180, 270):
            return False
        if not 0 < int(row["OriginalSize"]) <= 5_000_000:
            return False
        if len(base64.b64decode(row["OriginalMD5"], validate=True)) != 16:
            return False
    except (ValueError, OverflowError, binascii.Error):
        return False
    return True


def verified_cache(item):
    previous = CACHE.get(item["id"])
    if previous is None:
        return None
    if previous["metadata"] != item["metadata"] or previous["boxes"] != item["boxes"] or previous["stratum"] != item["stratum"]:
        return None
    old = previous["attempts"][-1]
    if previous["status"] != "eligible" or old.get("rights") != "original_landing_confirmed" or old.get("originalPageLicense") != item["metadata"]["License"] or old.get("landingUrl") != item["metadata"]["OriginalLandingURL"] or old.get("originalUrl") != item["metadata"]["OriginalURL"]:
        return None
    try:
        landing = Path(old["landingPath"]).read_bytes()
        if hashlib.sha256(landing).hexdigest() != old["landingSha256"] or fetch_module.page_photo_license(landing.decode("utf-8", errors="replace"), old["landingUrl"]) != item["metadata"]["License"]:
            return None
        pixels = Path(old["pixelPath"]).read_bytes()
        if hashlib.sha256(pixels).hexdigest() != old["pixelSha256"] or len(pixels) != int(item["metadata"]["OriginalSize"]) or base64.b64encode(hashlib.md5(pixels).digest()).decode("ascii") != item["metadata"]["OriginalMD5"]:
            return None
    except (OSError, KeyError, ValueError):
        return None
    return {**old, "status": "ready_for_decode", "reusedFromManifest": previous["cacheManifestSha256"], "cacheVerifiedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat()}


def acquire(item, target):
    first = verified_cache(item) or fetch_module.fetch(item, target, 15)
    attempts = [first]
    if "timed out" in first.get("reason", "").lower():
        second = fetch_module.fetch(item, target, 30)
        attempts.append(second)
    final = attempts[-1]
    if final["status"] == "ready_for_decode":
        try:
            data = Path(final["pixelPath"]).read_bytes()
            meta = item["metadata"]
            if len(data) != int(meta["OriginalSize"]) or base64.b64encode(hashlib.md5(data).digest()).decode("ascii") != meta["OriginalMD5"]:
                raise ValueError("original_size_or_md5_mismatch")
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                final["pixelFormat"] = image.format
            frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
            if frame is None:
                raise ValueError("opencv_decode_failed")
            rotation = float(meta["Rotation"])
            if rotation == 90:
                frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
            elif rotation == 180:
                frame = cv2.rotate(frame, cv2.ROTATE_180)
            elif rotation == 270:
                frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
            final["width"], final["height"] = frame.shape[1], frame.shape[0]
            final["status"] = "eligible"
        except Exception as error:
            final["status"] = "unavailable"
            final["reason"] = f"image_decode_failed: {str(error)[:100]}"
    return {"id": item["id"], "stratum": item["stratum"], "status": final["status"], "attempts": attempts, "pixelSha256": final.get("pixelSha256"), "pixelPath": final.get("pixelPath"), "width": final.get("width"), "height": final.get("height"), "metadata": item["metadata"], "boxes": item["boxes"]}


def main():
    deadline = time.monotonic() + 900
    if sha(V1_PATH) != EXPECTED_V1_SHA or sha(V2_PATH) != EXPECTED_V2_SHA or sha(V3_PATH) != EXPECTED_V3_SHA:
        raise SystemExit("PRIOR_MANIFEST_MISMATCH")
    v1 = json.loads(V1_PATH.read_text(encoding="utf-8"))
    v2 = json.loads(V2_PATH.read_text(encoding="utf-8"))
    v3 = json.loads(V3_PATH.read_text(encoding="utf-8"))
    for prior, digest in ((v2, EXPECTED_V2_SHA), (v3, EXPECTED_V3_SHA)):
        for group in prior["sets"].values():
            for previous in group["selected"]:
                if previous["id"] in CACHE:
                    raise SystemExit("PRIOR_CACHE_ID_DUPLICATE")
                CACHE[previous["id"]] = {**previous, "cacheManifestSha256": digest}
    if dict((r["LabelName"], r["DisplayName"]) for r in rows(SOURCE_ROOT / "oidv7-class-descriptions-boxable.csv")).get(MID) != "Human face":
        raise SystemExit("FACE_CLASS_MISMATCH")
    if OUTPUT.exists():
        manifest = json.loads(OUTPUT.read_text(encoding="utf-8"))
        if manifest.get("protocol") != "w61-v4" or manifest.get("v1ManifestSha256") != EXPECTED_V1_SHA or manifest.get("v2CheckpointSha256") != EXPECTED_V2_SHA or manifest.get("v3CheckpointSha256") != EXPECTED_V3_SHA or manifest.get("selectorSha256") != sha(Path(__file__)) or manifest.get("fetcherSha256") != sha(BASE / "w61-fetch-corpus.py"):
            raise SystemExit("CHECKPOINT_PROVENANCE_MISMATCH")
    else:
        manifest = {"protocol": "w61-v4", "v1ManifestSha256": EXPECTED_V1_SHA, "v2CheckpointSha256": EXPECTED_V2_SHA, "v3CheckpointSha256": EXPECTED_V3_SHA, "crossVersionIdsAllowed": True, "sources": v1["sources"], "sets": {}, "selectorSha256": sha(Path(__file__)), "fetcherSha256": sha(BASE / "w61-fetch-corpus.py")}
    manifest.setdefault("runs", []).append({"owner": "w61-model-preflight", "pid": os.getpid(), "deadlineSeconds": 900, "startedUtc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()})
    def checkpoint(status):
        manifest["status"] = status
        OUTPUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    checkpoint("incomplete")
    for split, names in FILES.items():
        for key, filename in names.items():
            if sha(SOURCE_ROOT / filename) != v1["sources"][split][key]["sha256"]:
                raise SystemExit("SOURCE_CSV_HASH_MISMATCH")
        metadata = {r["ImageID"].lower(): r for r in rows(SOURCE_ROOT / names["metadata"]) if metadata_ok(r)}
        boxes = defaultdict(list)
        for row in rows(SOURCE_ROOT / names["boxes"]):
            if row["LabelName"] == MID and box_ok(row):
                boxes[row["ImageID"].lower()].append(row)
        negative_ids = set()
        for row in rows(SOURCE_ROOT / names["labels"]):
            if row["LabelName"] == MID and row["Source"] in ("verification", "crowdsource-verification") and float(row["Confidence"]) == 0.0:
                negative_ids.add(row["ImageID"].lower())
        for bucket in (("development", "calibration") if split == "validation" else ("holdout",)):
            allowed = {image_id for image_id in metadata if split == "test" or ((hashlib.sha256(f"w61-v1|validation|{image_id}".encode()).digest()[0] < 128) == (bucket == "development"))}
            report = manifest["sets"].setdefault(bucket, {"sourceSplit": split, "selected": [], "attempted": [], "counts": {}})
            attempted = {entry["id"] for entry in report["attempted"]}
            for name in ("multiple", "lower", "small", "single", "negative"):
                quota = 20 if name == "negative" else 10
                cap = None if name == "lower" else (200 if name == "negative" else 100)
                candidates = (image_id for image_id in allowed if (image_id in negative_ids and not boxes[image_id] if name == "negative" else stratum(boxes[image_id]) == name))
                count = sum(entry["stratum"] == name for entry in report["selected"])
                ranked = rank(candidates, bucket, name)[:cap]
                if name == "lower" and len(ranked) != {"development": 22, "calibration": 25, "holdout": 130}[bucket]:
                    raise SystemExit("PREREGISTERED_LOWER_INVENTORY_MISMATCH")
                for offset in range(0, len(ranked), 2):
                    if count >= quota:
                        break
                    if time.monotonic() >= deadline:
                        checkpoint("incomplete_deadline")
                        print(json.dumps({"status": "incomplete_deadline", "manifest": str(OUTPUT), "sha256": sha(OUTPUT), "current": f"{bucket}/{name}", "pid": os.getpid()}, indent=2))
                        return
                    batch_ids = [image_id for image_id in ranked[offset:offset + 2] if image_id not in attempted]
                    batch_items = [{"id": image_id, "stratum": name, "metadata": metadata[image_id], "boxes": boxes[image_id]} for image_id in batch_ids]
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        outcomes = list(executor.map(lambda item: acquire(item, PIXELS / bucket), batch_items))
                    for outcome in outcomes:
                        report["attempted"].append(outcome)
                        attempted.add(outcome["id"])
                        if outcome["status"] == "eligible" and count < quota:
                            report["selected"].append(outcome)
                            count += 1
                        report["counts"][name] = count
                        checkpoint("incomplete")
                report["counts"][name] = count
                print(f"{bucket}/{name}: {count}/{quota}; attempted {len(report['attempted'])}", flush=True)
            manifest["sets"][bucket] = report
            checkpoint("incomplete")
    complete = all(all(report["counts"].get(name, 0) >= (20 if name == "negative" else 10) for name in ("multiple", "lower", "small", "single", "negative")) for report in manifest["sets"].values())
    selected = [item for group in manifest["sets"].values() for item in group["selected"]]
    ids = [item["id"] for item in selected]
    pixels = [item["pixelSha256"] for item in selected]
    checkpoint("corpus_duplicate_conflict" if len(ids) != len(set(ids)) or len(pixels) != len(set(pixels)) else "complete_selection" if complete else "incomplete_quota")
    print(json.dumps({"manifest": str(OUTPUT), "sha256": sha(OUTPUT), "counts": {name: report["counts"] for name, report in manifest["sets"].items()}}, indent=2))


if __name__ == "__main__":
    main()
