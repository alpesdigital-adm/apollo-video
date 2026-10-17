"""Freeze Open Images V7 face sample IDs before model inference."""

import csv
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


MID = "/m/0dzct"
LICENSES = {"https://creativecommons.org/licenses/by/2.0/", "https://creativecommons.org/licenses/by/4.0/"}
ROOT = Path(sys.argv[1])
OUTPUT = Path(sys.argv[2])
FILES = {
    "validation": {
        "boxes": ROOT / "validation-annotations-bbox.csv",
        "labels": ROOT / "oidv7-val-annotations-human-imagelabels.csv",
        "metadata": ROOT / "validation-images-with-rotation.csv",
    },
    "test": {
        "boxes": ROOT / "test-annotations-bbox.csv",
        "labels": ROOT / "oidv7-test-annotations-human-imagelabels.csv",
        "metadata": ROOT / "test-images-with-rotation.csv",
    },
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rows(path):
    with path.open(newline="", encoding="utf-8") as source:
        yield from csv.DictReader(source)


def ordered(ids, bucket, stratum):
    return sorted(ids, key=lambda image_id: (hashlib.sha256(f"w61-v1|{bucket}|{stratum}|{image_id}".encode()).digest(), image_id))


def is_valid_box(row):
    try:
        x1, x2, y1, y2 = (float(row[k]) for k in ("XMin", "XMax", "YMin", "YMax"))
    except (ValueError, KeyError):
        return False
    return 0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1 and row["Source"] in ("xclick", "activemil") and row["IsGroupOf"] == "0" and row["IsDepiction"] == "0"


def stratum_for(boxes):
    if len(boxes) >= 2:
        return "multiple"
    if len(boxes) == 1:
        face = boxes[0]
        y = (float(face["YMin"]) + float(face["YMax"])) / 2
        area = (float(face["XMax"]) - float(face["XMin"])) * (float(face["YMax"]) - float(face["YMin"]))
        if y >= 0.65:
            return "lower"
        if area <= 0.02:
            return "small"
        return "single"
    return None


def main():
    class_map = dict((line["LabelName"], line["DisplayName"]) for line in rows(ROOT / "oidv7-class-descriptions-boxable.csv"))
    if class_map.get(MID) != "Human face":
        raise SystemExit("FACE_CLASS_MISMATCH")
    manifest = {"protocol": "w61-v1", "class": {"mid": MID, "name": class_map[MID]}, "sources": {}, "sets": {}}
    for split, paths in FILES.items():
        manifest["sources"][split] = {key: {"url": {"boxes": f"https://storage.googleapis.com/openimages/v5/{path.name}", "labels": f"https://storage.googleapis.com/openimages/v7/{path.name}", "metadata": f"https://storage.googleapis.com/openimages/2018_04/{split}/{path.name}"}[key], "sha256": sha(path)} for key, path in paths.items()}
        images = {r["ImageID"].lower(): r for r in rows(paths["metadata"]) if r["License"].strip() in LICENSES and r["OriginalURL"].startswith("https://") and r["OriginalLandingURL"].startswith("https://")}
        boxes = defaultdict(list)
        for row in rows(paths["boxes"]):
            if row["LabelName"] == MID and is_valid_box(row):
                boxes[row["ImageID"].lower()].append(row)
        negatives = set()
        for row in rows(paths["labels"]):
            if row["LabelName"] == MID and row["Source"] in ("verification", "crowdsource-verification") and float(row["Confidence"]) == 0.0:
                negatives.add(row["ImageID"].lower())
        buckets = ("development", "calibration") if split == "validation" else ("holdout",)
        for bucket in buckets:
            eligible = {image_id for image_id in images if split == "test" or ((hashlib.sha256(f"w61-v1|validation|{image_id}".encode()).digest()[0] < 128) == (bucket == "development"))}
            selected = []
            for stratum in ("multiple", "lower", "small", "single"):
                candidates = (image_id for image_id in eligible if stratum_for(boxes[image_id]) == stratum)
                for image_id in ordered(candidates, bucket, stratum)[:10]:
                    selected.append({"id": image_id, "stratum": stratum, "metadata": images[image_id], "boxes": boxes[image_id], "rights": "pending_original_landing_verification", "pixels": "pending"})
            candidates = (image_id for image_id in eligible if image_id in negatives and not boxes[image_id])
            for image_id in ordered(candidates, bucket, "negative")[:20]:
                selected.append({"id": image_id, "stratum": "negative", "metadata": images[image_id], "boxes": [], "rights": "pending_original_landing_verification", "pixels": "pending"})
            manifest["sets"][bucket] = {"sourceSplit": split, "counts": dict(Counter(item["stratum"] for item in selected)), "items": selected}
    manifest["sources"]["classDescriptions"] = {"url": "https://storage.googleapis.com/openimages/v7/oidv7-class-descriptions-boxable.csv", "sha256": sha(ROOT / "oidv7-class-descriptions-boxable.csv")}
    manifest["selectionScriptSha256"] = sha(Path(__file__))
    OUTPUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(OUTPUT), "sha256": sha(OUTPUT), "counts": {key: val["counts"] for key, val in manifest["sets"].items()}}, indent=2))


if __name__ == "__main__":
    main()
