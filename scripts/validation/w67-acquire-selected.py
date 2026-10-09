"""Acquire only frozen W67 originals, preserving rights and byte failures."""

import argparse
import base64
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import time
from pathlib import Path

import requests
from PIL import Image


BASE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("w61_fetch", BASE / "w61-fetch-corpus.py")
FETCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FETCH)
HEADERS = {"User-Agent": "Apollo-W67-final-pixel-corpus/1.0"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def save_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def bounded_get(session, url, cap, deadline):
    if time.monotonic() >= deadline:
        raise TimeoutError("run_deadline")
    with session.get(url, headers=HEADERS, timeout=(10, 20), stream=True) as response:
        details = {"http": response.status_code, "finalUrl": response.url,
                   "contentType": response.headers.get("content-type"), "fetchedUtc": utc()}
        if response.status_code != 200:
            return details, b""
        data = bytearray()
        for chunk in response.iter_content(65536):
            if time.monotonic() >= deadline:
                raise TimeoutError("run_deadline")
            data.extend(chunk)
            if len(data) > cap:
                raise ValueError("response_exceeds_byte_cap")
        return details, bytes(data)


def acquire(item, root, session, deadline):
    image_id = item["id"]
    meta = item["metadata"]
    result = {"id": image_id, "startedUtc": utc(), "metadataLicense": meta["License"],
              "landingUrl": meta["OriginalLandingURL"], "originalUrl": meta["OriginalURL"]}
    try:
        landing, html = bounded_get(session, meta["OriginalLandingURL"], 2_000_000, deadline)
        result["landing"] = landing
        if html:
            path = root / "landing" / f"{image_id}.html"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(html)
            result["landing"].update({"sha256": digest(html), "byteSize": len(html), "path": str(path)})
        if landing["http"] == 429:
            result["status"] = "deferred_rate_limit"
            return result
        if landing["http"] != 200 or not (landing["contentType"] or "").lower().startswith("text/html"):
            result["status"] = "landing_unavailable"
            return result
        license_url = FETCH.page_photo_license(html.decode("utf-8", errors="replace"), meta["OriginalLandingURL"])
        result["originalPageLicense"] = license_url
        if license_url != meta["License"]:
            result["status"] = "original_license_unconfirmed"
            return result
        result["rights"] = "original_landing_confirmed"

        original, data = bounded_get(session, meta["OriginalURL"], 5_000_000, deadline)
        result["original"] = original
        if original["http"] == 429:
            result["status"] = "deferred_rate_limit"
            return result
        if original["http"] != 200 or not (original["contentType"] or "").lower().startswith("image/"):
            result["status"] = "original_unavailable"
            return result
        result["original"].update({"sha256": digest(data), "byteSize": len(data),
                                   "md5Base64": base64.b64encode(hashlib.md5(data).digest()).decode()})
        path = root / "original" / f"{image_id}.img"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        result["original"]["path"] = str(path)
        if len(data) != int(meta["OriginalSize"]) or result["original"]["md5Base64"] != meta["OriginalMD5"]:
            result["status"] = "original_identity_mismatch"
            return result
        Image.MAX_IMAGE_PIXELS = 25_000_000
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            orientation = image.getexif().get(274)
            if width < 1 or height < 1 or width > 20_000 or height > 20_000 or orientation not in (None, 1):
                result["status"] = "original_geometry_or_orientation_invalid"
                result["original"].update({"width": width, "height": height, "exifOrientation": orientation})
                return result
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
        result["original"].update({"width": width, "height": height, "exifOrientation": orientation,
                                   "metadataRotation": meta["Rotation"]})
        result["status"] = "original_verified"
    except (requests.exceptions.RequestException, OSError, ValueError, TimeoutError, Image.DecompressionBombError) as error:
        result["status"] = "acquisition_error"
        result["reason"] = type(error).__name__ if not isinstance(error, TimeoutError) else "run_deadline"
    result["finishedUtc"] = utc()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--deadline-seconds", type=int, default=600)
    args = parser.parse_args()
    if args.deadline_seconds < 60 or args.deadline_seconds > 900:
        raise SystemExit("INVALID_DEADLINE")
    if args.output_dir.exists():
        raise SystemExit("OUTPUT_DIR_EXISTS: preserve prior acquisition runs")
    selection_bytes = args.selection.read_bytes()
    selection = json.loads(selection_bytes)
    if selection.get("protocol") != "w67-final-pixel-oracle-metadata-selection-v1" or selection.get("pixelOracleCalled") is not False:
        raise SystemExit("SELECTION_PROTOCOL_MISMATCH")
    candidates = [item for split in ("development", "evaluation") for stratum in ("single", "multiple")
                  for item in selection["selected"][split][stratum]]
    if len(candidates) != 8 or len({item["id"] for item in candidates}) != 8:
        raise SystemExit("SELECTION_IDS_INVALID")
    args.output_dir.mkdir(parents=True)
    report_path = args.output_dir / "acquisition.json"
    report = {"protocol": "w67-original-acquisition-v1", "selectionSha256": digest(selection_bytes),
              "fetcherSha256": digest(Path(__file__).read_bytes()), "pid": os.getpid(),
              "startedUtc": utc(), "deadlineSeconds": args.deadline_seconds, "items": [],
              "status": "incomplete", "inferencePerformed": False, "renderPerformed": False}
    save_json(report_path, report)
    deadline = time.monotonic() + args.deadline_seconds
    with requests.Session() as session:
        for candidate in candidates:
            if time.monotonic() >= deadline:
                report["status"] = "deadline_partial"
                break
            item = acquire(candidate, args.output_dir, session, deadline)
            report["items"].append(item)
            save_json(report_path, report)
            if item["status"] == "deferred_rate_limit":
                report["status"] = "rate_limit_partial"
                break
    if report["status"] == "incomplete":
        report["status"] = "attempts_complete" if len(report["items"]) == 8 else "deadline_partial"
    report["finishedUtc"] = utc()
    report["unattemptedIds"] = [item["id"] for item in candidates[len(report["items"]):]]
    save_json(report_path, report)
    print(json.dumps({"report": str(report_path), "sha256": digest(report_path.read_bytes()),
                      "status": report["status"], "items": [{"id": item["id"], "status": item["status"]}
                                                              for item in report["items"]],
                      "unattemptedIds": report["unattemptedIds"]}, indent=2))


if __name__ == "__main__":
    main()
