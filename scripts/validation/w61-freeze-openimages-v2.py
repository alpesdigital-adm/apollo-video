"""Select rights-confirmed, decodable Open Images faces without model predictions."""

import csv
import hashlib
import importlib.util
import io
import json
import os
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image


BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("w61_fetch", BASE / "w61-fetch-corpus.py")
fetch_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_module)

MID = "/m/0dzct"
LICENSES = {"https://creativecommons.org/licenses/by/2.0/", "https://creativecommons.org/licenses/by/4.0/"}
SOURCE_ROOT = Path(sys.argv[1])
V1_PATH = Path(sys.argv[2])
OUTPUT = Path(sys.argv[3])
PIXELS = OUTPUT.parent / "corpus-v2"
EXPECTED_V1_SHA = "c8184f6b71552edf566b9d8dff51b3d1e76b76bba3aa581a43d919ba6e84fc5e"

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
    return sorted(ids, key=lambda image_id: (hashlib.sha256(f"w61-v2|{bucket}|{name}|{image_id}".encode()).digest(), image_id))


def acquire(item, target):
    first = fetch_module.fetch(item, target, 15)
    attempts = [first]
    if "timed out" in first.get("reason", "").lower():
        second = fetch_module.fetch(item, target, 30)
        attempts.append(second)
    final = attempts[-1]
    if final["status"] == "ready_for_decode":
        try:
            with Image.open(final["pixelPath"]) as image:
                image.verify()
            with Image.open(final["pixelPath"]) as image:
                image.load()
                final["pixelFormat"] = image.format
                final["width"], final["height"] = image.size
            final["status"] = "eligible"
        except Exception as error:
            final["status"] = "unavailable"
            final["reason"] = f"image_decode_failed: {str(error)[:100]}"
    return {"id": item["id"], "stratum": item["stratum"], "status": final["status"], "attempts": attempts, "pixelSha256": final.get("pixelSha256"), "pixelPath": final.get("pixelPath"), "width": final.get("width"), "height": final.get("height"), "metadata": item["metadata"], "boxes": item["boxes"]}


def main():
    deadline = time.monotonic() + 900
    if sha(V1_PATH) != EXPECTED_V1_SHA:
        raise SystemExit("V1_MANIFEST_MISMATCH")
    v1 = json.loads(V1_PATH.read_text(encoding="utf-8"))
    excluded = {item["id"] for group in v1["sets"].values() for item in group["items"]}
    if len(excluded) != 180:
        raise SystemExit("V1_EXCLUSION_COUNT_MISMATCH")
    if dict((r["LabelName"], r["DisplayName"]) for r in rows(SOURCE_ROOT / "oidv7-class-descriptions-boxable.csv")).get(MID) != "Human face":
        raise SystemExit("FACE_CLASS_MISMATCH")
    if OUTPUT.exists():
        manifest = json.loads(OUTPUT.read_text(encoding="utf-8"))
        if manifest.get("protocol") != "w61-v2" or manifest.get("v1ManifestSha256") != EXPECTED_V1_SHA or manifest.get("selectorSha256") != sha(Path(__file__)) or manifest.get("fetcherSha256") != sha(BASE / "w61-fetch-corpus.py"):
            raise SystemExit("CHECKPOINT_PROVENANCE_MISMATCH")
    else:
        manifest = {"protocol": "w61-v2", "v1ManifestSha256": EXPECTED_V1_SHA, "excludedV1Ids": sorted(excluded), "sources": v1["sources"], "sets": {}, "selectorSha256": sha(Path(__file__)), "fetcherSha256": sha(BASE / "w61-fetch-corpus.py")}
    manifest.setdefault("runs", []).append({"owner": "w61-model-preflight", "pid": os.getpid(), "deadlineSeconds": 900, "startedUtc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()})
    def checkpoint(status):
        manifest["status"] = status
        OUTPUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    checkpoint("incomplete")
    for split, names in FILES.items():
        for key, filename in names.items():
            if sha(SOURCE_ROOT / filename) != v1["sources"][split][key]["sha256"]:
                raise SystemExit("SOURCE_CSV_HASH_MISMATCH")
        metadata = {r["ImageID"].lower(): r for r in rows(SOURCE_ROOT / names["metadata"]) if r["License"].strip() in LICENSES and r["OriginalURL"].startswith("https://") and r["OriginalLandingURL"].startswith("https://") and r["ImageID"].lower() not in excluded}
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
                cap = 200 if name == "negative" else 100
                candidates = (image_id for image_id in allowed if (image_id in negative_ids and not boxes[image_id] if name == "negative" else stratum(boxes[image_id]) == name))
                count = sum(entry["stratum"] == name for entry in report["selected"])
                ranked = rank(candidates, bucket, name)[:cap]
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
    checkpoint("complete_selection" if all(all(report["counts"].get(name, 0) >= (20 if name == "negative" else 10) for name in ("multiple", "lower", "small", "single", "negative")) for report in manifest["sets"].values()) else "incomplete_quota")
    print(json.dumps({"manifest": str(OUTPUT), "sha256": sha(OUTPUT), "counts": {name: report["counts"] for name, report in manifest["sets"].items()}}, indent=2))


if __name__ == "__main__":
    main()
