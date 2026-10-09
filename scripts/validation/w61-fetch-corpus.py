"""Fetch frozen IDs with original-page license confirmation; never replace failures."""

import argparse
import datetime
import hashlib
import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests


def page_photo_license(markup, landing):
    for raw in re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', markup, flags=re.IGNORECASE | re.DOTALL):
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
                if node.get("@type") == "ImageObject" and node.get("acquireLicensePage") == landing:
                    return node.get("license")
                stack.extend(value for value in node.values() if isinstance(value, (dict, list)))
    return None


def fetch(item, target, timeout):
    image_id = item["id"]
    meta = item["metadata"]
    result = {"id": image_id, "stratum": item["stratum"], "metadataLicense": meta["License"], "landingUrl": meta["OriginalLandingURL"], "originalUrl": meta["OriginalURL"]}
    try:
        response = requests.get(meta["OriginalLandingURL"], timeout=(timeout, timeout), headers={"User-Agent": "Apollo-W61-corpus-validation/1.0"})
        result["landingHttp"] = response.status_code
        result["landingFinalUrl"] = response.url
        result["landingFetchedUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        result["landingSha256"] = hashlib.sha256(response.content).hexdigest()
        target.mkdir(parents=True, exist_ok=True)
        landing_path = target / "landing" / f"{image_id}.html"
        landing_path.parent.mkdir(parents=True, exist_ok=True)
        landing_path.write_bytes(response.content)
        result["landingPath"] = str(landing_path)
        if response.status_code != 200:
            raise ValueError("landing_http_not_200")
        result["originalPageLicense"] = page_photo_license(response.text, meta["OriginalLandingURL"])
        if result["originalPageLicense"] != meta["License"]:
            raise ValueError("original_page_license_unconfirmed")
        result["rights"] = "original_landing_confirmed"
        with requests.get(meta["OriginalURL"], timeout=(timeout, timeout), stream=True, headers={"User-Agent": "Apollo-W61-corpus-validation/1.0"}) as image:
            result["pixelHttp"] = image.status_code
            if image.status_code != 200 or not image.headers.get("content-type", "").startswith("image/"):
                raise ValueError("original_image_unavailable")
            data = bytearray()
            for chunk in image.iter_content(65536):
                data.extend(chunk)
                if len(data) > 5_000_000:
                    raise ValueError("original_image_over_5MB_cap")
        target.mkdir(parents=True, exist_ok=True)
        path = target / image_id
        path.write_bytes(data)
        result["pixelBytes"] = len(data)
        result["pixelSha256"] = hashlib.sha256(data).hexdigest()
        result["pixelPath"] = str(path)
        result["status"] = "ready_for_decode"
    except Exception as error:
        result["status"] = "unavailable"
        result["reason"] = str(error)[:150]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("set", choices=("development", "calibration", "holdout"))
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--retry-from", type=Path)
    args = parser.parse_args()
    raw = args.manifest.read_bytes()
    manifest_sha = hashlib.sha256(raw).hexdigest()
    if manifest_sha != "c8184f6b71552edf566b9d8dff51b3d1e76b76bba3aa581a43d919ba6e84fc5e":
        raise SystemExit("FROZEN_MANIFEST_HASH_MISMATCH")
    items = json.loads(raw)["sets"][args.set]["items"]
    previous = {}
    if args.retry_from:
        old = json.loads(args.retry_from.read_text(encoding="utf-8"))
        if old["manifestSha256"] != manifest_sha or old["set"] != args.set:
            raise SystemExit("RETRY_REPORT_MISMATCH")
        previous = {result["id"]: result for result in old["items"]}
    retry_items = [item for item in items if not previous or "timed out" in previous[item["id"]].get("reason", "").lower()]
    with ThreadPoolExecutor(max_workers=2 if previous else 4) as executor:
        fetched = list(executor.map(lambda item: fetch(item, args.output_dir / args.set, 30 if previous else 15), retry_items))
    updates = {result["id"]: result for result in fetched}
    results = [updates.get(item["id"], previous.get(item["id"])) for item in items]
    report = {"manifestSha256": manifest_sha, "set": args.set, "retryFrom": str(args.retry_from) if args.retry_from else None, "retriedIds": [item["id"] for item in retry_items], "items": results}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.output_dir / f"{args.set}-acquisition.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    counts = {status: sum(result["status"] == status for result in results) for status in ("ready_for_decode", "unavailable")}
    reasons = sorted({result.get("reason", "") for result in results if result["status"] == "unavailable"})
    print(json.dumps({"set": args.set, "report": str(report_path), "sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(), "counts": counts, "unavailableReasons": reasons}, indent=2))


if __name__ == "__main__":
    main()
