"""Freeze W67 v2 IDs from historically licensed local HTML; no network or pixels."""

import argparse
import hashlib
import html
import importlib.util
import json
import re
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote, urlparse


BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("w67_v1", BASE / "w67-select-openimages.py")
V1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(V1)
INVENTORY_SHA256 = "4d273863096f75a6aa3c86944657496359b757e7c9d78c5f6c6389f69c935b2d"
IMAGE_ID = re.compile(r"[0-9a-f]{16}")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def require(condition, code):
    if not condition:
        raise ValueError(code)


def in_private_root(path, root):
    resolved = Path(path).resolve(strict=True)
    require(resolved.is_relative_to(root.resolve(strict=True)), "LANDING_OUTSIDE_PRIVATE_ROOT")
    return resolved


def author_identity(url):
    parsed = urlparse(url)
    require(parsed.scheme == "https" and parsed.netloc.lower() == "www.flickr.com", "AUTHOR_URL_INVALID")
    segments = [unquote(segment).lower() for segment in parsed.path.split("/") if segment]
    require(len(segments) >= 2 and segments[0] in ("photos", "people"), "AUTHOR_URL_INVALID")
    return segments[1]


def page_attribution(markup, landing_url):
    for raw in re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                          markup, flags=re.IGNORECASE | re.DOTALL):
        try:
            document = json.loads(html.unescape(raw))
        except json.JSONDecodeError:
            continue
        stack = [document]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, dict):
                if node.get("@type") == "ImageObject" and node.get("acquireLicensePage") == landing_url:
                    author = node.get("author")
                    if not isinstance(author, dict):
                        author = node.get("creator")
                    return {"license": node.get("license"),
                            "author": author.get("name") if isinstance(author, dict) else None,
                            "authorUrl": author.get("url") if isinstance(author, dict) else None}
                stack.extend(value for value in node.values() if isinstance(value, (dict, list)))
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--v1-selection", type=Path, required=True)
    parser.add_argument("--v5", type=Path, required=True)
    parser.add_argument("--inventory-output", type=Path, required=True)
    parser.add_argument("--selection-output", type=Path, required=True)
    args = parser.parse_args()
    if args.inventory_output.exists() or args.selection_output.exists():
        raise SystemExit("OUTPUT_EXISTS")
    require(digest(args.inventory) == INVENTORY_SHA256, "INVENTORY_HASH_MISMATCH")
    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    require(inventory.get("protocol") == "w67-local-cache-inventory-v1" and
            inventory.get("cacheCandidateIdCount") == 27, "INVENTORY_IDENTITY_INVALID")
    v1 = json.loads(args.v1_selection.read_text(encoding="utf-8"))
    v5 = json.loads(args.v5.read_text(encoding="utf-8"))
    require(digest(args.v1_selection) == inventory["selectionSha256"], "V1_SELECTION_HASH_MISMATCH")
    require(v5.get("protocol") == "w61-v5" and v5.get("status") == "complete_selection", "V5_INVALID")
    source_hashes = {}
    for kind, filename in V1.FILES.items():
        actual = digest(args.source / filename)
        require(actual == inventory["sourceHashes"][kind], f"SOURCE_HASH_MISMATCH:{kind}")
        source_hashes[kind] = actual
    classes = args.source / "oidv7-class-descriptions-boxable.csv"
    require(digest(classes) == inventory["sourceHashes"]["classDescriptions"], "CLASS_HASH_MISMATCH")
    require(dict((row["LabelName"], row["DisplayName"]) for row in V1.rows(classes)).get(V1.FACE) == "Human face",
            "FACE_CLASS_MISMATCH")
    source_hashes["classDescriptions"] = digest(classes)
    excluded_v5 = {item["id"].lower() for group in v5["sets"].values()
                   for item in group["selected"]}
    excluded_v1 = {item["id"].lower() for group in v1["selected"].values()
                   for items in group.values() for item in items}
    require(len(excluded_v5) == 180 and len(excluded_v1) == 8, "EXCLUSION_COUNT_INVALID")
    require(len(excluded_v5 | excluded_v1) == inventory["excludedIdCount"], "EXCLUSION_INVENTORY_MISMATCH")
    candidate_ids = set(inventory["cacheFailures"]) | {item["id"] for item in inventory["verified"]}
    require(len(candidate_ids) == 27 and all(IMAGE_ID.fullmatch(item) for item in candidate_ids) and
            not candidate_ids.intersection(excluded_v5 | excluded_v1), "CANDIDATE_IDS_INVALID")
    cache_paths = {name: args.private_root / name for name in inventory["cacheManifestHashes"]}
    for name, path in cache_paths.items():
        require(digest(path) == inventory["cacheManifestHashes"][name], f"CACHE_HASH_MISMATCH:{name}")
    metadata = {row["ImageID"].lower(): row for row in V1.rows(args.source / V1.FILES["metadata"])
                if row["ImageID"].lower() in candidate_ids}
    boxes = defaultdict(list)
    labels = defaultdict(list)
    for row in V1.rows(args.source / V1.FILES["boxes"]):
        image_id = row["ImageID"].lower()
        if image_id in candidate_ids and row["LabelName"] == V1.FACE:
            boxes[image_id].append(row)
    for row in V1.rows(args.source / V1.FILES["labels"]):
        image_id = row["ImageID"].lower()
        if image_id in candidate_ids and row["LabelName"] == V1.FACE:
            labels[image_id].append(row)
    attempts = defaultdict(list)
    for name, path in cache_paths.items():
        cache = json.loads(path.read_text(encoding="utf-8"))
        require(cache.get("protocol") in ("w61-v2", "w61-v3", "w61-v4"), f"CACHE_PROTOCOL_INVALID:{name}")
        for group in cache["sets"].values():
            if group.get("sourceSplit") != "validation":
                continue
            for item in group.get("selected", []) + group.get("attempted", []):
                if item["id"].lower() in candidate_ids:
                    for attempt in item.get("attempts", []):
                        if attempt.get("rights") == "original_landing_confirmed":
                            attempts[item["id"].lower()].append((name, attempt))

    findings = []
    eligible = defaultdict(list)
    for image_id in sorted(candidate_ids):
        meta = metadata.get(image_id)
        reasons = []
        if not meta or not V1.metadata_ok(meta) or meta.get("Subset") != "validation":
            reasons.append("source_metadata_invalid")
        face_boxes = boxes[image_id]
        if not face_boxes or not all(V1.box_ok(box) for box in face_boxes):
            reasons.append("human_boxes_invalid")
        if not any(row["Confidence"] in ("1", "1.0") and row["Source"] in
                   ("verification", "crowdsource-verification") for row in labels[image_id]):
            reasons.append("positive_human_label_missing")
        split = V1.split_of(image_id)
        stratum = "single" if len(face_boxes) == 1 else "multiple"
        rights = None
        attempt_errors = []
        if meta and not reasons:
            for name, attempt in attempts[image_id]:
                try:
                    require(attempt.get("landingUrl") == meta["OriginalLandingURL"] and
                            attempt.get("originalUrl") == meta["OriginalURL"] and
                            attempt.get("originalPageLicense") == meta["License"] and
                            attempt.get("landingFinalUrl") == meta["OriginalLandingURL"] and
                            attempt.get("landingHttp") == 200, "ATTEMPT_IDENTITY_MISMATCH")
                    landing = in_private_root(attempt["landingPath"], args.private_root)
                    require(landing.stat().st_size <= 2_000_000, "LANDING_SIZE_LIMIT")
                    markup = landing.read_bytes()
                    landing_hash = hashlib.sha256(markup).hexdigest()
                    require(landing_hash == attempt["landingSha256"], "LANDING_HASH_MISMATCH")
                    attribution = page_attribution(markup.decode("utf-8", errors="replace"),
                                                    meta["OriginalLandingURL"])
                    require(attribution and attribution["license"] == meta["License"] and
                            attribution["license"] in V1.LICENSES and
                            attribution["author"] == meta["Author"] and
                            author_identity(attribution["authorUrl"]) ==
                            author_identity(meta["AuthorProfileURL"]), "ATTRIBUTION_MISMATCH")
                    rights = {"historicalLandingFetchedUtc": attempt.get("landingFetchedUtc"),
                              "landingUrl": meta["OriginalLandingURL"], "landingSha256": landing_hash,
                              "landingBytes": len(markup), "manifest": name,
                              "manifestSha256": inventory["cacheManifestHashes"][name],
                              "license": attribution["license"], "author": attribution["author"],
                              "authorProfileUrl": meta["AuthorProfileURL"],
                              "currentRightsRecheckedOnline": False}
                    break
                except (KeyError, OSError, TypeError, ValueError) as error:
                    attempt_errors.append(str(error)[:80])
        if rights is None:
            reasons.extend(attempt_errors)
            reasons.append("no_matching_historical_rights_html")
        item = {"id": image_id, "split": split, "stratum": stratum,
                "eligible": rights is not None and not reasons,
                "reasons": sorted(set(reasons)),
                "sourceMetadata": meta, "humanFaceBoxes": face_boxes,
                "positiveHumanFaceLabels": labels[image_id], "rights": rights}
        findings.append(item)
        if item["eligible"]:
            eligible[(split, stratum)].append(item)
    counts = {split: {stratum: len(eligible[(split, stratum)])
                      for stratum in ("single", "multiple")}
              for split in ("development", "evaluation")}
    inventory_report = {"protocol": "w67-official-derivative-eligibility-v2",
                        "inventorySha256": INVENTORY_SHA256, "selectorSha256": digest(Path(__file__)),
                        "v1SelectionSha256": digest(args.v1_selection), "v5Sha256": digest(args.v5),
                        "sourceHashes": source_hashes,
                        "cacheManifestHashes": inventory["cacheManifestHashes"],
                        "candidateCount": len(findings), "eligibleCounts": counts,
                        "findings": findings, "networkUsed": False, "pixelBytesRead": False,
                        "inferencePerformed": False, "renderPerformed": False,
                        "qualifiedCorpus": False}
    with args.inventory_output.open("x", encoding="utf-8") as stream:
        json.dump(inventory_report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"inventory": str(args.inventory_output),
                      "inventorySha256": digest(args.inventory_output), "counts": counts}, indent=2))
    missing = [(split, stratum, counts[split][stratum]) for split in counts
               for stratum in counts[split] if counts[split][stratum] < 2]
    if missing:
        raise SystemExit(f"QUOTA_NOT_AVAILABLE:{missing}")
    selected = {split: {stratum: sorted(eligible[(split, stratum)],
                                        key=lambda item: (hashlib.sha256(
                                            f'w67-v2|{split}|{stratum}|{item["id"]}'.encode()).hexdigest(),
                                            item["id"]))[:2]
                        for stratum in ("single", "multiple")}
                for split in ("development", "evaluation")}
    ids = [item["id"] for groups in selected.values() for items in groups.values() for item in items]
    require(len(ids) == 8 and len(set(ids)) == 8, "SELECTION_NOT_DISJOINT")
    selection = {"protocol": "w67-official-derivative-metadata-selection-v2",
                 "eligibilitySha256": digest(args.inventory_output), "selectorSha256": digest(Path(__file__)),
                 "ranking": "sha256(w67-v2|split|stratum|id), then id", "counts": counts,
                 "selected": selected, "pixels": "not_acquired", "faceSafety": "unknown",
                 "networkUsed": False, "qualifiedCorpus": False}
    with args.selection_output.open("x", encoding="utf-8") as stream:
        json.dump(selection, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"selection": str(args.selection_output),
                      "selectionSha256": digest(args.selection_output), "ids": ids}, indent=2))


if __name__ == "__main__":
    main()
