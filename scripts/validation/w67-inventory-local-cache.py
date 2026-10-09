"""Inventory historically verified W67 originals in local W61 V2-V4 caches; no network."""

import argparse
import base64
import csv
import hashlib
import importlib.util
import json
from collections import defaultdict
from pathlib import Path


BASE = Path(__file__).resolve().parent
SELECT_SPEC = importlib.util.spec_from_file_location("w67_select", BASE / "w67-select-openimages.py")
SELECT = importlib.util.module_from_spec(SELECT_SPEC)
SELECT_SPEC.loader.exec_module(SELECT)
FETCH_SPEC = importlib.util.spec_from_file_location("w61_fetch", BASE / "w61-fetch-corpus.py")
FETCH = importlib.util.module_from_spec(FETCH_SPEC)
FETCH_SPEC.loader.exec_module(FETCH)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def within(path, root):
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError("CACHE_PATH_OUTSIDE_PRIVATE_ROOT")
    return resolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--v1-selection", type=Path, required=True)
    parser.add_argument("--v5", type=Path, required=True)
    parser.add_argument("--cache", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("OUTPUT_EXISTS")
    frozen = json.loads(args.v1_selection.read_text(encoding="utf-8"))
    v5 = json.loads(args.v5.read_text(encoding="utf-8"))
    expected_sources = frozen["sourceHashes"]
    for kind, filename in SELECT.FILES.items():
        if digest(args.source / filename) != expected_sources[kind]:
            raise SystemExit(f"SOURCE_HASH_MISMATCH:{kind}")
    excluded = {item["id"] for group in v5["sets"].values() for item in group["selected"]}
    excluded.update(item["id"] for groups in frozen["selected"].values() for items in groups.values() for item in items)
    metadata = {row["ImageID"].lower(): row for row in SELECT.rows(args.source / SELECT.FILES["metadata"])
                if SELECT.metadata_ok(row)}
    boxes = defaultdict(list)
    for row in SELECT.rows(args.source / SELECT.FILES["boxes"]):
        if row["LabelName"] == SELECT.FACE:
            boxes[row["ImageID"].lower()].append(row)
    positive = set()
    for row in SELECT.rows(args.source / SELECT.FILES["labels"]):
        if (row["LabelName"] == SELECT.FACE and row["Confidence"] in ("1", "1.0") and
                row["Source"] in ("verification", "crowdsource-verification")):
            positive.add(row["ImageID"].lower())
    eligible = {image_id for image_id in metadata if image_id not in excluded and image_id in positive and
                boxes[image_id] and all(SELECT.box_ok(row) for row in boxes[image_id])}

    found = defaultdict(list)
    cache_hashes = {}
    private_root = args.v1_selection.parent
    for path in args.cache:
        cache_hashes[path.name] = digest(path)
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("protocol") not in ("w61-v2", "w61-v3", "w61-v4"):
            raise SystemExit(f"CACHE_PROTOCOL_INVALID:{path.name}")
        for group in manifest["sets"].values():
            if group.get("sourceSplit") != "validation":
                continue
            for item in group.get("selected", []) + group.get("attempted", []):
                image_id = item["id"].lower()
                if image_id not in eligible:
                    continue
                for attempt in item.get("attempts", []):
                    if attempt.get("rights") != "original_landing_confirmed":
                        continue
                    found[image_id].append({"manifest": path.name, "attempt": attempt})

    verified = {}
    failures = {}
    for image_id in sorted(found):
        meta = metadata[image_id]
        for entry in found[image_id]:
            attempt = entry["attempt"]
            if (attempt.get("landingUrl") != meta["OriginalLandingURL"] or
                    attempt.get("originalUrl") != meta["OriginalURL"] or
                    attempt.get("originalPageLicense") != meta["License"]):
                failures[image_id] = "cache_identity_or_license_mismatch"
                continue
            if not attempt.get("pixelPath") or not attempt.get("pixelSha256"):
                failures[image_id] = "cache_original_bytes_missing"
                continue
            try:
                landing = within(Path(attempt["landingPath"]), private_root)
                original = within(Path(attempt["pixelPath"]), private_root)
                if landing.stat().st_size > 2_000_000 or original.stat().st_size > 5_000_000:
                    raise ValueError("CACHE_BYTE_CAP")
                landing_bytes = landing.read_bytes()
                original_bytes = original.read_bytes()
                if (hashlib.sha256(landing_bytes).hexdigest() != attempt["landingSha256"] or
                        FETCH.page_photo_license(landing_bytes.decode("utf-8", errors="replace"),
                                                 meta["OriginalLandingURL"]) != meta["License"] or
                        hashlib.sha256(original_bytes).hexdigest() != attempt["pixelSha256"] or
                        len(original_bytes) != int(meta["OriginalSize"]) or
                        base64.b64encode(hashlib.md5(original_bytes).digest()).decode() != meta["OriginalMD5"]):
                    raise ValueError("CACHE_HASH_OR_LICENSE_MISMATCH")
            except (OSError, KeyError, ValueError) as error:
                failures[image_id] = str(error)[:80]
                continue
            split = SELECT.split_of(image_id)
            stratum = "single" if len(boxes[image_id]) == 1 else "multiple"
            verified[image_id] = {"id": image_id, "split": split, "stratum": stratum,
                                  "metadata": meta, "positiveFaceLabel": True, "boxes": boxes[image_id],
                                  "landingPath": str(landing), "landingSha256": digest(landing),
                                  "originalPath": str(original), "originalSha256": digest(original),
                                  "originalBytes": len(original_bytes),
                                  "cachedFrom": entry["manifest"],
                                  "rights": "historical_original_landing_confirmed_current_rights_unverified"}
            failures.pop(image_id, None)
            break
    counts = {split: {stratum: sum(item["split"] == split and item["stratum"] == stratum
                                   for item in verified.values()) for stratum in ("single", "multiple")}
              for split in ("development", "evaluation")}
    report = {"protocol": "w67-local-cache-inventory-v1", "selectionSha256": digest(args.v1_selection),
              "inventoryScriptSha256": digest(Path(__file__)), "sourceHashes": expected_sources,
              "cacheManifestHashes": cache_hashes, "excludedIdCount": len(excluded),
              "eligibleMetadataIdCount": len(eligible), "cacheCandidateIdCount": len(found),
              "verifiedCounts": counts, "verified": list(verified.values()),
        "cacheFailures": failures, "networkUsed": False, "inferencePerformed": False,
              "renderPerformed": False, "qualifiedCorpus": False}
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"report": str(args.output), "sha256": digest(args.output),
                      "eligibleMetadataIds": len(eligible), "cacheCandidateIds": len(found),
                      "verifiedCounts": counts, "cacheFailures": len(failures)}, indent=2))


if __name__ == "__main__":
    main()
