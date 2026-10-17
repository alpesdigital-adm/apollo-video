"""Read-only Open Images V5 Rotation=0 quota inventory before acquisition."""

import base64
import binascii
import csv
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

SOURCE = Path(sys.argv[1])
V1 = Path(sys.argv[2])
OUTPUT = Path(sys.argv[3])
FACE = "/m/0dzct"
LICENSES = {"https://creativecommons.org/licenses/by/2.0/", "https://creativecommons.org/licenses/by/4.0/"}
FILES = {
    "validation": {"boxes": "validation-annotations-bbox.csv", "labels": "oidv7-val-annotations-human-imagelabels.csv", "metadata": "validation-images-with-rotation.csv"},
    "test": {"boxes": "test-annotations-bbox.csv", "labels": "oidv7-test-annotations-human-imagelabels.csv", "metadata": "test-images-with-rotation.csv"},
}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def rows(path):
    with path.open(newline="", encoding="utf-8") as source:
        yield from csv.DictReader(source)


def metadata_ok(row):
    if row["License"].strip() not in LICENSES or not row["OriginalURL"].startswith("https://") or not row["OriginalLandingURL"].startswith("https://"):
        return False
    try:
        return (float(row["Rotation"]) == 0 and
                0 < int(row["OriginalSize"]) <= 5_000_000 and
                len(base64.b64decode(row["OriginalMD5"], validate=True)) == 16)
    except (ValueError, OverflowError, binascii.Error):
        return False


def box_ok(row):
    try:
        x1, x2, y1, y2 = (float(row[key]) for key in ("XMin", "XMax", "YMin", "YMax"))
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


def main():
    v1 = json.loads(V1.read_text(encoding="utf-8"))
    report = {"protocol": "w61-v5-rotation0-local-inventory", "sourceHashes": {}, "splits": {},
              "rules": {"rotation": 0, "metadata": "V4 license/URL/OriginalMD5/OriginalSize prefilter",
                        "split": "w61-v1 validation hash half; test holdout", "rank": "w61-v3 stable hash",
                        "strata": ["multiple", "lower", "small", "single", "negative"],
                        "rightsAndMirror": "not proven by this metadata inventory"}}
    descriptions = SOURCE / "oidv7-class-descriptions-boxable.csv"
    assert digest(descriptions) == v1["sources"]["classDescriptions"]["sha256"]
    assert dict((row["LabelName"], row["DisplayName"]) for row in rows(descriptions))[FACE] == "Human face"
    report["sourceHashes"]["classDescriptions"] = digest(descriptions)
    for source_split, names in FILES.items():
        for kind, filename in names.items():
            expected = v1["sources"][source_split][kind]["sha256"]
            assert digest(SOURCE / filename) == expected, f"{source_split}/{kind} hash mismatch"
            report["sourceHashes"][f"{source_split}/{kind}"] = expected
        metadata = {row["ImageID"].lower(): row for row in rows(SOURCE / names["metadata"]) if metadata_ok(row)}
        boxes = defaultdict(list)
        for row in rows(SOURCE / names["boxes"]):
            if row["LabelName"] == FACE and box_ok(row):
                boxes[row["ImageID"].lower()].append(row)
        negative_ids = set()
        for row in rows(SOURCE / names["labels"]):
            if row["LabelName"] == FACE and row["Source"] in ("verification", "crowdsource-verification") and float(row["Confidence"]) == 0.0:
                negative_ids.add(row["ImageID"].lower())
        for bucket in (("development", "calibration") if source_split == "validation" else ("holdout",)):
            allowed = {image_id for image_id in metadata if source_split == "test" or
                       ((hashlib.sha256(f"w61-v1|validation|{image_id}".encode()).digest()[0] < 128) == (bucket == "development"))}
            counts = {}
            first = {}
            for name in report["rules"]["strata"]:
                if name == "negative":
                    candidates = [image_id for image_id in allowed if image_id in negative_ids and not boxes[image_id]]
                else:
                    candidates = [image_id for image_id in allowed if stratum(boxes[image_id]) == name]
                ranked = rank(candidates, bucket, name)
                counts[name] = len(ranked)
                first[name] = ranked[:10]
            report["splits"][bucket] = {"sourceSplit": source_split, "metadataCandidateCount": len(allowed),
                                         "strataCandidateCounts": counts, "firstTenRankedIds": first,
                                         "quotaFeasibleBeforeRightsAndBytes": all(counts[name] >= (20 if name == "negative" else 10) for name in counts)}
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "sha256": digest(OUTPUT),
                      "counts": {key: value["strataCandidateCounts"] for key, value in report["splits"].items()}}, indent=2))


if __name__ == "__main__":
    main()
