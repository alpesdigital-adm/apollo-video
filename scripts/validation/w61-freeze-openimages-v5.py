"""Preselect and acquire the Open Images CVDF derivative without model inference."""

import argparse
import base64
import binascii
import csv
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import re
import time
from collections import defaultdict
from pathlib import Path

import requests
from PIL import Image


BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("w61_fetch", BASE / "w61-fetch-corpus.py")
FETCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FETCH)
FACE = "/m/0dzct"
LICENSES = {"https://creativecommons.org/licenses/by/2.0/", "https://creativecommons.org/licenses/by/4.0/"}
STRATA = ("multiple", "lower", "small", "single", "negative")
FILES = {
    "validation": {"boxes": "validation-annotations-bbox.csv", "labels": "oidv7-val-annotations-human-imagelabels.csv", "metadata": "validation-images-with-rotation.csv"},
    "test": {"boxes": "test-annotations-bbox.csv", "labels": "oidv7-test-annotations-human-imagelabels.csv", "metadata": "test-images-with-rotation.csv"},
}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def rows(path):
    with path.open(newline="", encoding="utf-8") as source:
        yield from csv.DictReader(source)


def metadata_ok(row):
    if row["License"].strip() not in LICENSES or not row["OriginalURL"].startswith("https://") or not row["OriginalLandingURL"].startswith("https://"):
        return False
    try:
        return float(row["Rotation"]) == 0 and 0 < int(row["OriginalSize"]) <= 5_000_000 and len(base64.b64decode(row["OriginalMD5"], validate=True)) == 16
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


def write_json(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def create_plan(args):
    v1 = json.loads(args.v1.read_text(encoding="utf-8"))
    inventory = json.loads(args.inventory.read_text(encoding="utf-8"))
    if inventory["protocol"] != "w61-v5-rotation0-local-inventory":
        raise SystemExit("INVENTORY_PROTOCOL_MISMATCH")
    plan = {"protocol": "w61-v5-cvdf-plan", "sourceManifestSha256": digest(args.v1),
            "inventorySha256": digest(args.inventory), "sourceHashes": inventory["sourceHashes"],
            "splitRule": "w61-v1 validation hash half; test holdout", "rankRule": "w61-v3 actual V4 selector order",
            "sets": {}}
    descriptions = args.source / "oidv7-class-descriptions-boxable.csv"
    if digest(descriptions) != v1["sources"]["classDescriptions"]["sha256"]:
        raise SystemExit("CLASS_DESCRIPTION_HASH_MISMATCH")
    for source_split, names in FILES.items():
        for kind, filename in names.items():
            if digest(args.source / filename) != v1["sources"][source_split][kind]["sha256"]:
                raise SystemExit(f"SOURCE_HASH_MISMATCH:{source_split}/{kind}")
        metadata = {row["ImageID"].lower(): row for row in rows(args.source / names["metadata"]) if metadata_ok(row)}
        boxes = defaultdict(list)
        for row in rows(args.source / names["boxes"]):
            if row["LabelName"] == FACE and box_ok(row):
                boxes[row["ImageID"].lower()].append(row)
        negatives = set()
        for row in rows(args.source / names["labels"]):
            if row["LabelName"] == FACE and row["Source"] in ("verification", "crowdsource-verification") and float(row["Confidence"]) == 0.0:
                negatives.add(row["ImageID"].lower())
        for bucket in (("development", "calibration") if source_split == "validation" else ("holdout",)):
            allowed = {image_id for image_id in metadata if source_split == "test" or
                       ((hashlib.sha256(f"w61-v1|validation|{image_id}".encode()).digest()[0] < 128) == (bucket == "development"))}
            candidates = {}
            for name in STRATA:
                if name == "negative":
                    ids = [image_id for image_id in allowed if image_id in negatives and not boxes[image_id]]
                else:
                    ids = [image_id for image_id in allowed if stratum(boxes[image_id]) == name]
                ranked = rank(ids, bucket, name)
                cap = None if name == "lower" else (200 if name == "negative" else 100)
                candidates[name] = [{"id": image_id, "stratum": name, "sourceSplit": source_split,
                                     "metadata": metadata[image_id], "boxes": boxes[image_id]}
                                    for image_id in ranked[:cap]]
                if len(ranked) != inventory["splits"][bucket]["strataCandidateCounts"][name]:
                    raise SystemExit(f"INVENTORY_COUNT_MISMATCH:{bucket}/{name}")
            plan["sets"][bucket] = {"sourceSplit": source_split, "candidates": candidates}
    write_json(args.output, plan)
    print(json.dumps({"plan": str(args.output), "sha256": digest(args.output),
                      "counts": {bucket: {name: len(items) for name, items in group["candidates"].items()}
                                 for bucket, group in plan["sets"].items()}}, indent=2))


def rights_cache(paths):
    cache = defaultdict(list)
    for path in paths:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for group in manifest["sets"].values():
            for item in group.get("selected", []) + group.get("attempted", []):
                for attempt in item.get("attempts", []):
                    cache[item["id"]].append({"item": item, "attempt": attempt, "manifestSha256": digest(path)})
    return cache


def original_aspect(candidate, cached):
    metadata = candidate["metadata"]
    for entry in reversed(cached):
        item, attempt = entry["item"], entry["attempt"]
        path = attempt.get("pixelPath") or item.get("pixelPath")
        expected = attempt.get("pixelSha256") or item.get("pixelSha256")
        if not path or not expected:
            continue
        try:
            data = Path(path).read_bytes()
            if sha_bytes(data) != expected or len(data) != int(metadata["OriginalSize"]) or base64.b64encode(hashlib.md5(data).digest()).decode() != metadata["OriginalMD5"]:
                continue
            # V2/V3/V4 already decoded these original bytes and recorded the
            # dimensions. Reopening a very large original here would defeat
            # the V5 mirror-only decode limit; bind recorded dimensions to the
            # reverified original byte identity instead.
            width = item.get("width") or attempt.get("width")
            height = item.get("height") or attempt.get("height")
            if isinstance(width, int) and isinstance(height, int) and 0 < width <= 20_000 and 0 < height <= 20_000:
                return [width, height]
        except (OSError, ValueError):
            continue
    return None


def cached_rights(candidate, cached):
    metadata = candidate["metadata"]
    for entry in reversed(cached):
        attempt = entry["attempt"]
        if (attempt.get("landingUrl") != metadata["OriginalLandingURL"] or
            attempt.get("originalUrl") != metadata["OriginalURL"] or
            attempt.get("originalPageLicense") != metadata["License"] or
            attempt.get("rights") != "original_landing_confirmed"):
            continue
        try:
            data = Path(attempt["landingPath"]).read_bytes()
            if sha_bytes(data) != attempt["landingSha256"] or FETCH.page_photo_license(data.decode("utf-8", errors="replace"), attempt["landingUrl"]) != metadata["License"]:
                continue
        except (OSError, KeyError):
            continue
        return {"rights": "original_landing_confirmed", "landingUrl": attempt["landingUrl"],
                "landingFinalUrl": attempt.get("landingFinalUrl"), "landingFetchedUtc": attempt.get("landingFetchedUtc"),
                "landingPath": attempt["landingPath"], "landingSha256": attempt["landingSha256"],
                "originalPageLicense": attempt["originalPageLicense"],
                "reusedFromManifest": entry["manifestSha256"]}
    return None


def get_landing(candidate, target, cached, timeout):
    reused = cached_rights(candidate, cached)
    if reused:
        return reused
    metadata, image_id = candidate["metadata"], candidate["id"]
    response = requests.get(metadata["OriginalLandingURL"], timeout=(10, timeout),
                            headers={"User-Agent": "Apollo-W61-corpus-validation/1.0"})
    path = target / "landing" / f"{image_id}.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(response.content)
    result = {"landingUrl": metadata["OriginalLandingURL"], "landingFinalUrl": response.url,
              "landingHttp": response.status_code, "landingFetchedUtc": utc(),
              "landingPath": str(path), "landingSha256": sha_bytes(response.content),
              "originalPageLicense": FETCH.page_photo_license(response.text, metadata["OriginalLandingURL"])}
    if response.status_code == 429:
        return {**result, "status": "deferred_rate_limit", "reason": "landing_http_429"}
    if response.status_code != 200 or result["originalPageLicense"] != metadata["License"]:
        return {**result, "status": "rights_unconfirmed", "reason": "original_page_license_unconfirmed"}
    return {**result, "rights": "original_landing_confirmed"}


def get_mirror(candidate, target, timeout):
    image_id = candidate["id"]
    url = f"https://open-images-dataset.s3.amazonaws.com/{candidate['sourceSplit']}/{image_id}.jpg"
    with requests.get(url, timeout=(10, timeout), stream=True,
                      headers={"User-Agent": "Apollo-W61-corpus-validation/1.0"}) as response:
        result = {"mirrorUrl": url, "mirrorFinalUrl": response.url,
                  "mirrorHttp": response.status_code, "mirrorFetchedUtc": utc(),
                  "mirrorContentType": response.headers.get("content-type"),
                  "mirrorContentLength": response.headers.get("content-length"),
                  "mirrorEtagRaw": response.headers.get("etag")}
        if response.status_code == 429:
            return {**result, "status": "deferred_rate_limit", "reason": "mirror_http_429"}
        if response.status_code != 200 or not (response.headers.get("content-type") or "").startswith("image/jpeg"):
            return {**result, "status": "mirror_unavailable", "reason": "mirror_http_or_type_invalid"}
        data = bytearray()
        for chunk in response.iter_content(65536):
            data.extend(chunk)
            if len(data) > 5_000_000:
                return {**result, "status": "mirror_unavailable", "reason": "mirror_exceeds_5mb_cap"}
    payload = bytes(data)
    result.update({"mirrorBytes": len(payload), "mirrorSha256": sha_bytes(payload),
                   "mirrorMd5Hex": hashlib.md5(payload).hexdigest()})
    path = target / "mirror" / candidate["sourceSplit"] / f"{image_id}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    result["mirrorPath"] = str(path)
    etag = result["mirrorEtagRaw"] or ""
    if not re.fullmatch(r'"[a-f0-9]{32}"', etag) or etag[1:-1] != result["mirrorMd5Hex"]:
        return {**result, "status": "mirror_unavailable", "reason": "mirror_etag_md5_mismatch"}
    try:
        if result["mirrorContentLength"] and int(result["mirrorContentLength"]) != len(payload):
            raise ValueError("mirror_content_length_mismatch")
        Image.MAX_IMAGE_PIXELS = 4_000_000
        with Image.open(io.BytesIO(payload)) as image:
            if image.format != "JPEG" or min(image.size) < 1 or max(image.size) > 1024:
                raise ValueError("mirror_jpeg_dimensions_invalid")
            orientation = image.getexif().get(274)
            if orientation not in (None, 1):
                raise ValueError("mirror_exif_orientation_not_neutral")
            dimensions = list(image.size)
            image.verify()
        with Image.open(io.BytesIO(payload)) as image:
            image.load()
    except (OSError, ValueError) as error:
        return {**result, "status": "mirror_unavailable", "reason": str(error)[:120]}
    return {**result, "status": "ready_for_aspect",
            "mirrorWidth": dimensions[0], "mirrorHeight": dimensions[1],
            "mirrorExifOrientation": orientation}


def acquire_one(candidate, target, cache):
    cached = cache.get(candidate["id"], [])
    attempts = []
    current_rights = None
    for timeout in (15, 30):
        try:
            rights = current_rights or get_landing(candidate, target, cached, timeout)
            if rights.get("status"):
                return {**rights, "attempts": attempts, "id": candidate["id"], "stratum": candidate["stratum"]}
            current_rights = rights
            mirror = get_mirror(candidate, target, timeout)
            result = {**rights, **mirror}
            if mirror["status"] == "ready_for_aspect":
                original = original_aspect(candidate, cached)
                if original and abs(mirror["mirrorWidth"] / mirror["mirrorHeight"] - original[0] / original[1]) > 0.01:
                    result.update({"status": "mirror_unavailable", "reason": "mirror_original_aspect_mismatch"})
                else:
                    result.update({"status": "eligible", "originalDimensions": original,
                                   "aspectEvidence": "cached_original_compared" if original else "aspect_original_unverified"})
            return {**result, "attempts": attempts, "id": candidate["id"], "stratum": candidate["stratum"]}
        except requests.exceptions.Timeout as error:
            attempts.append({"timeoutSeconds": timeout, "error": type(error).__name__, "atUtc": utc()})
        except requests.exceptions.RequestException as error:
            return {"id": candidate["id"], "stratum": candidate["stratum"], "status": "network_unavailable",
                    "reason": type(error).__name__, "attempts": attempts}
    return {"id": candidate["id"], "stratum": candidate["stratum"], "status": "network_unavailable",
            "reason": "same_id_timeout_twice", "attempts": attempts}


def acquire_plan(args):
    freeze = json.loads(args.freeze.read_text(encoding="utf-8"))
    plan_sha = digest(args.plan)
    if (freeze.get("protocol") != "w61-v5-pre-acquisition-freeze" or freeze.get("planSha256") != plan_sha or freeze.get("selectorSha256") != digest(Path(__file__))):
        raise SystemExit("V5_FREEZE_MISMATCH")
    for path, key in ((args.v2, "v2Sha256"), (args.v3, "v3Sha256"), (args.v4, "v4Sha256")):
        if digest(path) != freeze[key]:
            raise SystemExit(f"PRIOR_MANIFEST_MISMATCH:{key}")
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    if plan["protocol"] != "w61-v5-cvdf-plan":
        raise SystemExit("V5_PLAN_PROTOCOL_MISMATCH")
    cache = rights_cache((args.v2, args.v3, args.v4))
    if args.checkpoint.exists():
        manifest = json.loads(args.checkpoint.read_text(encoding="utf-8"))
        if (manifest.get("planSha256") != plan_sha or
            manifest.get("freezeSha256") not in (digest(args.freeze), freeze.get("supersedesSha256"))):
            raise SystemExit("V5_CHECKPOINT_MISMATCH")
        if manifest["freezeSha256"] != digest(args.freeze):
            manifest.setdefault("freezeRevisions", []).append({"previousSha256": manifest["freezeSha256"],
                "currentSha256": digest(args.freeze), "revisionReason": freeze.get("revisionReason"),
                "reconciledUtc": utc()})
            manifest["freezeSha256"] = digest(args.freeze)
        if manifest["runs"] and not manifest["runs"][-1].get("endedUtc"):
            manifest["runs"][-1]["interruptedObservedUtc"] = utc()
            manifest["runs"][-1]["interruptionReason"] = freeze.get("revisionReason")
    else:
        manifest = {"protocol": "w61-v5", "planSha256": plan_sha, "freezeSha256": digest(args.freeze),
                    "sets": {bucket: {"sourceSplit": group["sourceSplit"], "selected": [], "attempted": []}
                             for bucket, group in plan["sets"].items()}, "runs": []}
    run = {"owner": "w61-model-preflight", "pid": os.getpid(), "startedUtc": utc(),
           "deadlineSeconds": 900}
    manifest["runs"].append(run)
    deadline = time.monotonic() + 900

    def checkpoint(status):
        manifest["status"] = status
        write_json(args.checkpoint, manifest)

    checkpoint("incomplete")
    for bucket, group in plan["sets"].items():
        report = manifest["sets"][bucket]
        for name in STRATA:
            quota = 20 if name == "negative" else 10
            for candidate in group["candidates"][name]:
                if sum(item["stratum"] == name for item in report["selected"]) >= quota:
                    break
                prior = next((item for item in report["attempted"] if item["id"] == candidate["id"]), None)
                if prior and prior["status"] != "deferred_rate_limit":
                    continue
                if time.monotonic() >= deadline:
                    run["endedUtc"] = utc()
                    checkpoint("incomplete_deadline")
                    print(json.dumps({"status": manifest["status"], "checkpoint": str(args.checkpoint),
                                      "sha256": digest(args.checkpoint)}))
                    return
                outcome = acquire_one(candidate, args.pixels, cache)
                history = prior["history"] if prior else []
                history.append({**outcome, "atUtc": utc()})
                result = {**candidate, **outcome, "history": history}
                if prior:
                    report["attempted"].remove(prior)
                report["attempted"].append(result)
                if result["status"] == "eligible":
                    report["selected"].append(result)
                checkpoint("incomplete")
                if result["status"] == "eligible":
                    selected = [item for selected_group in manifest["sets"].values() for item in selected_group["selected"]]
                    if len({item["mirrorSha256"] for item in selected}) != len(selected):
                        run["endedUtc"] = utc()
                        checkpoint("corpus_duplicate_conflict")
                        print(json.dumps({"status": manifest["status"], "id": candidate["id"],
                                          "checkpoint": str(args.checkpoint), "sha256": digest(args.checkpoint)}))
                        return
                if result["status"] == "deferred_rate_limit":
                    run["endedUtc"] = utc()
                    checkpoint("paused_rate_limit")
                    print(json.dumps({"status": manifest["status"], "id": candidate["id"],
                                      "checkpoint": str(args.checkpoint), "sha256": digest(args.checkpoint)}))
                    return
            count = sum(item["stratum"] == name for item in report["selected"])
            print(f"{bucket}/{name}: {count}/{quota}; attempted {len(report['attempted'])}", flush=True)
    selected = [item for group in manifest["sets"].values() for item in group["selected"]]
    ids, pixels = [item["id"] for item in selected], [item["mirrorSha256"] for item in selected]
    complete = all(sum(item["stratum"] == name for item in group["selected"]) >= (20 if name == "negative" else 10)
                   for group in manifest["sets"].values() for name in STRATA)
    run["endedUtc"] = utc()
    checkpoint("corpus_duplicate_conflict" if len(ids) != len(set(ids)) or len(pixels) != len(set(pixels))
               else "complete_selection" if complete else "incomplete_quota")
    print(json.dumps({"status": manifest["status"], "checkpoint": str(args.checkpoint),
                      "sha256": digest(args.checkpoint),
                      "counts": {bucket: {name: sum(item["stratum"] == name for item in group["selected"])
                                           for name in STRATA} for bucket, group in manifest["sets"].items()}}, indent=2))


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("source", type=Path)
    plan.add_argument("v1", type=Path)
    plan.add_argument("inventory", type=Path)
    plan.add_argument("output", type=Path)
    acquire = commands.add_parser("acquire")
    for name in ("plan", "freeze", "v2", "v3", "v4", "checkpoint", "pixels"):
        acquire.add_argument(name, type=Path)
    args = parser.parse_args()
    create_plan(args) if args.command == "plan" else acquire_plan(args)


if __name__ == "__main__":
    main()
