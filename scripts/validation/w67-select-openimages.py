"""Freeze W67 Open Images candidates using local metadata only; never read pixels."""

import argparse
import base64
import binascii
import csv
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path


FACE = "/m/0dzct"
LICENSES = {"https://creativecommons.org/licenses/by/2.0/", "https://creativecommons.org/licenses/by/4.0/"}
FILES = {
    "metadata": "validation-images-with-rotation.csv",
    "boxes": "validation-annotations-bbox.csv",
    "labels": "oidv7-val-annotations-human-imagelabels.csv",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def rows(path):
    with path.open(encoding="utf-8", newline="") as stream:
        yield from csv.DictReader(stream)


def metadata_ok(row):
    if row["License"].strip() not in LICENSES:
        return False
    if not row["OriginalURL"].startswith("https://") or not row["OriginalLandingURL"].startswith("https://"):
        return False
    try:
        return (float(row["Rotation"]) == 0 and
                1 <= int(row["OriginalSize"]) <= 5_000_000 and
                len(base64.b64decode(row["OriginalMD5"], validate=True)) == 16)
    except (ValueError, OverflowError, binascii.Error):
        return False


def box_ok(row):
    try:
        x1, x2, y1, y2 = (float(row[name]) for name in ("XMin", "XMax", "YMin", "YMax"))
    except (ValueError, KeyError):
        return False
    return (row["Source"] in ("xclick", "activemil") and row["Confidence"] == "1" and
            all(row[name] == "0" for name in ("IsGroupOf", "IsDepiction", "IsOccluded", "IsTruncated")) and
            0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1)


def split_of(image_id):
    return ("development" if hashlib.sha256(f"w67-v1|split|{image_id}".encode()).digest()[0] < 128
            else "evaluation")


def rank(image_id, split, stratum):
    return (hashlib.sha256(f"w67-v1|{split}|{stratum}|{image_id}".encode()).hexdigest(), image_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--v1", type=Path, required=True)
    parser.add_argument("--v5", type=Path, required=True)
    parser.add_argument("--evaluation", type=Path, action="append", default=[])
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("OUTPUT_EXISTS: frozen selection cannot be overwritten")
    v1 = json.loads(args.v1.read_text(encoding="utf-8"))
    v5 = json.loads(args.v5.read_text(encoding="utf-8"))
    if v5.get("protocol") != "w61-v5" or v5.get("status") != "complete_selection":
        raise SystemExit("V5_MANIFEST_NOT_COMPLETE")
    source_hashes = {}
    for kind, filename in FILES.items():
        path = args.source / filename
        actual = sha256(path)
        expected = v1["sources"]["validation"][kind]["sha256"]
        if actual != expected:
            raise SystemExit(f"SOURCE_HASH_MISMATCH:{kind}")
        source_hashes[kind] = actual
    classes = args.source / "oidv7-class-descriptions-boxable.csv"
    source_hashes["classDescriptions"] = sha256(classes)
    if source_hashes["classDescriptions"] != v1["sources"]["classDescriptions"]["sha256"]:
        raise SystemExit("CLASS_DESCRIPTION_HASH_MISMATCH")
    if dict((row["LabelName"], row["DisplayName"]) for row in rows(classes)).get(FACE) != "Human face":
        raise SystemExit("FACE_LABEL_MISMATCH")

    excluded = set()
    for group in v5["sets"].values():
        for item in group["selected"]:
            excluded.add(item["id"].lower())
    if len(excluded) != 180:
        raise SystemExit(f"V5_EXCLUSION_COUNT:{len(excluded)}")
    evaluation_hashes = {}
    for path in args.evaluation:
        report = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(report.get("items"), list):
            raise SystemExit(f"EVALUATION_ITEMS_INVALID:{path.name}")
        evaluation_hashes[path.name] = sha256(path)
        for item in report["items"]:
            image_id = item.get("id")
            if not isinstance(image_id, str) or not re.fullmatch(r"[0-9a-f]{16}", image_id):
                raise SystemExit(f"EVALUATION_ID_INVALID:{path.name}")
            excluded.add(image_id)

    metadata = {}
    for row in rows(args.source / FILES["metadata"]):
        image_id = row["ImageID"].lower()
        if not re.fullmatch(r"[0-9a-f]{16}", image_id):
            continue
        if image_id in metadata:
            raise SystemExit(f"DUPLICATE_METADATA_ID:{image_id}")
        if metadata_ok(row):
            metadata[image_id] = row
    face_boxes = defaultdict(list)
    for row in rows(args.source / FILES["boxes"]):
        if row["LabelName"] == FACE:
            face_boxes[row["ImageID"].lower()].append(row)
    positive_labels = defaultdict(list)
    for row in rows(args.source / FILES["labels"]):
        if (row["LabelName"] == FACE and row["Confidence"] in ("1", "1.0") and
                row["Source"] in ("verification", "crowdsource-verification")):
            positive_labels[row["ImageID"].lower()].append(row)

    inventory = {split: {stratum: [] for stratum in ("single", "multiple")}
                 for split in ("development", "evaluation")}
    rejected_invalid_face = 0
    for image_id, meta in metadata.items():
        if image_id in excluded:
            continue
        boxes = face_boxes[image_id]
        if not boxes or not positive_labels[image_id]:
            continue
        if not all(box_ok(box) for box in boxes):
            rejected_invalid_face += 1
            continue
        split = split_of(image_id)
        stratum = "single" if len(boxes) == 1 else "multiple"
        inventory[split][stratum].append({"id": image_id, "metadata": meta,
                                          "positiveFaceLabels": positive_labels[image_id], "boxes": boxes})

    selected = {}
    counts = {}
    for split, strata in inventory.items():
        selected[split], counts[split] = {}, {}
        for stratum, items in strata.items():
            ranked = sorted(items, key=lambda item: rank(item["id"], split, stratum))
            counts[split][stratum] = len(ranked)
            if len(ranked) < 2:
                raise SystemExit(f"QUOTA_NOT_AVAILABLE:{split}:{stratum}:{len(ranked)}")
            selected[split][stratum] = ranked[:2]
    ids = [item["id"] for strata in selected.values() for items in strata.values() for item in items]
    if len(ids) != 8 or len(set(ids)) != 8 or set(ids) & excluded:
        raise SystemExit("SELECTION_NOT_DISJOINT")

    output = {
        "protocol": "w67-final-pixel-oracle-metadata-selection-v1",
        "protocolSha256": sha256(args.protocol),
        "selectorSha256": sha256(Path(__file__)),
        "v1Sha256": sha256(args.v1),
        "v5Sha256": sha256(args.v5),
        "evaluationHashes": evaluation_hashes,
        "sourceHashes": source_hashes,
        "seed": "w67-v1",
        "excludedIdCount": len(excluded),
        "metadataEligibleCounts": counts,
        "rejectedInvalidFaceImages": rejected_invalid_face,
        "selected": selected,
        "rights": "individual_original_landing_unverified",
        "pixels": "not_acquired_or_verified",
        "annotationProvenance": "Open Images validation Human face boxes; original Source field retained per row",
        "faceConvention": "dataset bounding box; visible-face versus whole-head convention not independently adjudicated",
        "faceBoxCompleteness": "Open Images validation positive Human face label with validation box annotations; no separate train subset required",
        "cleanFaceControlEligible": False,
        "eyes": "unknown",
        "qualifiedCorpus": False,
        "pixelOracleCalled": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(output, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"output": str(args.output), "sha256": sha256(args.output),
                      "counts": counts, "selectedIds": ids,
                      "rightsAndPixels": "pending"}, indent=2))


if __name__ == "__main__":
    main()
