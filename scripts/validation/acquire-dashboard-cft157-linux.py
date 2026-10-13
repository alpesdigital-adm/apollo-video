"""Fixed CI Linux CfT acquisition. Stdlib only; no browser/ML/subprocess load.

Blocking DNS/OS IO is contained by the authenticated external cgroup owner,
not claimed to be interrupted by a Python socket timeout. Two GETs, no retry.
"""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import time
import urllib.request
import zipfile

VERSION = "157.0.8090.0"
REVISION = "@2ea1b71af70d7fc5d41325dda8df37c1f98ac531"
OBJECT = "157.0.8090.0/linux64/chrome-linux64.zip"
ZIP_URL = "https://storage.googleapis.com/chrome-for-testing-public/" + OBJECT
METADATA_URL = "https://storage.googleapis.com/storage/v1/b/chrome-for-testing-public/o/157.0.8090.0%2Flinux64%2Fchrome-linux64.zip"
GENERATION = "1791347120490195"
SIZE = 201551103
MD5 = "BvMevHF6ZEenSob5RNSB4g=="
CRC32C = "SFhLhQ=="
CREATED = "2026-10-07T04:25:20.561Z"
CHUNK = 65536
EXPANDED_LIMIT = 1200 * 1024 * 1024
ENTRY_LIMIT = 512 * 1024 * 1024


def require(value, code):
    if not value:
        raise ValueError(code)


class Budget:
    def __init__(self, deadline_ms, now=time.monotonic, wall=time.time):
        self.now = now
        self.started = now()
        remaining = (deadline_ms / 1000) - wall()
        require(math.isfinite(remaining) and remaining > 30, "CFT_DEADLINE_ADMISSION")
        self.end = self.started + min(240, remaining)
        self.work_end = self.end - 30

    def check(self, end=None):
        remaining = min(self.work_end, end if end is not None else self.work_end) - self.now()
        require(remaining > 0, "CFT_DEADLINE")
        return remaining

    def phase(self, seconds):
        self.check()
        return min(self.work_end, self.now() + seconds)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "CFT_JSON_DUPLICATE")
            result[key] = value
        return result

    def number(value):
        result = float(value)
        require(math.isfinite(result), "CFT_JSON_NONFINITE")
        return result

    return json.loads(raw, object_pairs_hook=pairs, parse_float=number,
                      parse_constant=lambda _: require(False, "CFT_JSON_NONFINITE"))


def validate_metadata(value):
    require(type(value) is dict, "CFT_METADATA_TYPE")
    expected = {"bucket": "chrome-for-testing-public", "name": OBJECT, "generation": GENERATION,
                "metageneration": "1", "contentType": "application/zip",
                "size": str(SIZE), "md5Hash": MD5, "crc32c": CRC32C, "timeCreated": CREATED}
    for key, wanted in expected.items():
        require(value.get(key) == wanted, "CFT_METADATA_" + key.upper())
    return expected


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("CFT_REDIRECT_PROHIBITED")


def fetch(url, destination, maximum, budget, seconds, opener=None):
    require(url in (METADATA_URL, ZIP_URL), "CFT_URL_NOT_FIXED")
    end = budget.phase(seconds)
    # Empty ProxyHandler prohibits ambient proxy injection; TLS verification is default.
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),
        NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    response, primary, facts = None, None, None
    digest, md5, total = hashlib.sha256(), hashlib.md5(usedforsecurity=False), 0
    try:
        response = opener.open(urllib.request.Request(url, method="GET"), timeout=min(30, budget.check(end)))
        budget.check(end)
        require(response.status == 200 and response.geturl() == url, "CFT_HTTP_STATUS_OR_URL")
        length = response.headers.get("Content-Length")
        require(type(length) is str and re.fullmatch(r"[0-9]+", length) and 0 < int(length) <= maximum,
                "CFT_HTTP_LENGTH")
        if url == ZIP_URL:
            require(int(length) == SIZE and response.headers.get("x-goog-generation") == GENERATION,
                    "CFT_OBJECT_GENERATION_OR_LENGTH")
            hashes = [item.strip() for item in response.headers.get("x-goog-hash", "").split(",")]
            require(hashes.count("md5=" + MD5) == 1 and hashes.count("crc32c=" + CRC32C) == 1,
                    "CFT_OBJECT_CHECKSUM_HEADERS")
        with destination.open("xb") as output:
            while True:
                budget.check(end)
                chunk = response.read(min(CHUNK, maximum + 1 - total))
                budget.check(end)
                if not chunk:
                    break
                total += len(chunk)
                require(total <= maximum, "CFT_DOWNLOAD_BYTE_BOUND")
                digest.update(chunk); md5.update(chunk); output.write(chunk)
                budget.check(end)
            output.flush(); os.fsync(output.fileno()); budget.check(end)
        require(total == int(length), "CFT_HTTP_TRUNCATED")
        measured_md5 = base64.b64encode(md5.digest()).decode("ascii")
        if url == ZIP_URL:
            require(total == SIZE and measured_md5 == MD5, "CFT_OBJECT_MD5_OR_SIZE")
        facts = {"url": url, "finalUrl": response.geturl(), "httpStatus": response.status,
                "bytes": total, "sha256": digest.hexdigest(), "md5Measured": measured_md5,
                "crc32cOfficial": CRC32C if url == ZIP_URL else None, "crc32cCalculated": False,
                "redirects": [], "connectionFinallyClosed": False}
    except BaseException as error:
        primary = error
    finally:
        try:
            if response is not None:
                response.close()
            if facts is not None:
                facts["connectionFinallyClosed"] = True
            budget.check(end)
        except BaseException as error:
            primary = primary or error
    if primary is not None:
        raise primary
    return facts


def archive_members(archive, budget, end):
    infos = archive.infolist()
    require(0 < len(infos) <= 2000, "CFT_ZIP_COUNT")
    names, expanded = set(), 0
    for info in infos:
        budget.check(end)
        name = info.orig_filename
        require(0 < len(name) <= 1024, "CFT_ZIP_NAME_BOUND")
        require(name == info.filename and all(ord(character) >= 32 and ord(character) != 127 for character in name),
                "CFT_ZIP_RAW_NAME")
        require(name.startswith("chrome-linux64/") and "\\" not in name and ":" not in name,
                "CFT_ZIP_PATH")
        parts = name.rstrip("/").split("/")
        require(all(part and part not in (".", "..") for part in parts), "CFT_ZIP_PATH")
        require(name.casefold().rstrip("/") not in names, "CFT_ZIP_DUPLICATE")
        names.add(name.casefold().rstrip("/"))
        mode = info.external_attr >> 16
        require(not stat.S_ISLNK(mode) and not mode & 0o7000
                and stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), "CFT_ZIP_MODE")
        require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                "CFT_ZIP_ENCODING")
        require(0 <= info.file_size <= ENTRY_LIMIT and (not info.is_dir() or info.file_size == 0), "CFT_ZIP_ENTRY_SIZE")
        expanded += info.file_size
        require(expanded <= EXPANDED_LIMIT, "CFT_ZIP_EXPANDED_SIZE")
    # File-as-ancestor collisions also fail before writing any member.
    files = {info.filename.rstrip("/").casefold() for info in infos if not info.is_dir()}
    for name in names:
        parts = name.split("/")
        require(all("/".join(parts[:index]) not in files for index in range(1, len(parts))), "CFT_ZIP_PARENT_FILE")
    require("chrome-linux64/chrome" in files, "CFT_ZIP_CHROME_MISSING")
    return infos


def confined(root, target):
    require(root.resolve() == root and root in target.parents and target.resolve() == target, "CFT_CONFINEMENT")
    for path in (target, *target.parents):
        if path == root.parent:
            break
        if path.exists() or path.is_symlink():
            require(not path.is_symlink(), "CFT_SYMLINK")
    return target


def extract(archive_path, root, budget):
    end = budget.phase(90)
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive_members(archive, budget, end)
        for info in infos:
            budget.check(end)
            target = confined(root, root / info.filename.rstrip("/"))
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            confined(root, target)
            total = 0
            with archive.open(info) as source, target.open("xb") as output:
                while True:
                    budget.check(end); chunk = source.read(CHUNK); budget.check(end)
                    if not chunk:
                        break
                    total += len(chunk); require(total <= info.file_size, "CFT_EXTRACT_SIZE")
                    output.write(chunk)
                output.flush(); os.fsync(output.fileno()); budget.check(end)
            require(total == info.file_size, "CFT_EXTRACT_TRUNCATED")
            # Preserve executable capability only, never group/world writes or SUID.
            target.chmod(0o700 if (info.external_attr >> 16) & 0o111 else 0o600)
            budget.check(end)


def inventory(root, budget):
    end, rows, total = budget.phase(30), [], 0
    for directory, directories, files in os.walk(root / "chrome-linux64", followlinks=False):
        budget.check(end)
        for name in directories:
            require(not (Path(directory) / name).is_symlink(), "CFT_INVENTORY_SYMLINK")
        for name in sorted(files):
            path = confined(root, Path(directory) / name)
            before = path.stat(follow_symlinks=False)
            require(stat.S_ISREG(before.st_mode) and not before.st_mode & 0o7000, "CFT_INVENTORY_MODE")
            digest, size = hashlib.sha256(), 0
            with path.open("rb") as source:
                while True:
                    budget.check(end); chunk = source.read(CHUNK); budget.check(end)
                    if not chunk:
                        break
                    size += len(chunk); require(size <= ENTRY_LIMIT, "CFT_INVENTORY_SIZE"); digest.update(chunk)
            after = path.stat(follow_symlinks=False)
            require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) and size == before.st_size,
                    "CFT_INVENTORY_CHANGED")
            rows.append({"path": path.relative_to(root).as_posix(), "bytes": size, "sha256": digest.hexdigest(),
                         "mode": stat.S_IMODE(before.st_mode)})
            total += size; require(len(rows) <= 2000 and total <= EXPANDED_LIMIT, "CFT_INVENTORY_BOUND")
    rows.sort(key=lambda row: row["path"])
    require(any(row["path"] == "chrome-linux64/chrome" and row["mode"] == 0o700 for row in rows), "CFT_CHROME_NOT_EXECUTABLE")
    return {"schemaVersion": "dashboard-cft157-linux-inventory/v1", "files": rows, "fileCount": len(rows), "totalBytes": total}


def publish(path, value, budget):
    budget.check()
    raw = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf8")
    pending = path.with_name(path.name + ".pending")
    with pending.open("xb") as output:
        output.write(raw); output.flush(); os.fsync(output.fileno()); budget.check()
    require(not path.exists(), "CFT_PUBLISH_EXISTS")
    os.link(pending, path)  # Exclusive atomic publication; never replace a previous receipt.
    pending.unlink(); budget.check()
    require(path.read_bytes() == raw, "CFT_PUBLICATION_READBACK"); budget.check()
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True); parser.add_argument("--deadline-ms", required=True, type=int)
    parser.add_argument("--source-sha256", required=True); parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    budget = Budget(args.deadline_ms)
    require(sys.platform == "linux" and os.getuid() > 0, "CFT_LINUX_NORMAL_UID")
    require(re.fullmatch(r"pidfd-consumer-acquisition-[a-f0-9-]{36}", args.run_id), "CFT_RUN_ID")
    require(re.fullmatch(r"[a-f0-9]{64}", args.source_sha256), "CFT_SOURCE_PIN")
    require(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == args.source_sha256, "CFT_SOURCE_CHANGED")
    source_head = os.environ.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[a-f0-9]{40}", source_head), "CFT_SOURCE_HEAD")
    temporary = Path(os.environ["RUNNER_TEMP"])
    root = Path(args.root)
    require(temporary.is_absolute() and temporary.resolve() == temporary and root.parent == temporary
            and re.fullmatch(r"apollo-dashboard-cft157-[0-9]+-[0-9]+", root.name), "CFT_EXCLUSIVE_ROOT")
    root.mkdir(mode=0o700)  # Existing output is a hard failure; no delete/cleanup.
    receipt = {"schemaVersion": "dashboard-cft157-linux-acquisition/v1", "runId": args.run_id,
               "sourceHead": source_head, "sourceSha256": args.source_sha256, "pid": os.getpid(),
               "version": VERSION, "revision": REVISION, "root": str(root), "requests": [], "success": False,
               "nativeBrowserExecuted": False, "errors": []}
    try:
        metadata = root / "metadata-gcs.json"
        receipt["requests"].append(fetch(METADATA_URL, metadata, 65536, budget, 30))
        validate_metadata(strict_json(metadata.read_bytes())); budget.check()
        receipt["requests"].append(fetch(ZIP_URL, root / "chrome-linux64.zip", SIZE, budget, 90))
        extract(root / "chrome-linux64.zip", root, budget)
        facts = inventory(root, budget)
        inventory_binding = publish(root / "inventory.json", facts, budget)
        receipt["inventory"] = inventory_binding; receipt["outcome"] = "files-verified-awaiting-owner"
        # A manifest alone does not claim owner ChildProcess close/cgroup terminality.
        publish(root / "manifest.json", receipt, budget)
        budget.check()
        print(json.dumps({"outcome": receipt["outcome"], "runId": args.run_id}), flush=True)
        budget.check()
    except BaseException as error:
        receipt["outcome"] = "failed"; receipt["errors"].append({"type": type(error).__name__,
            "messageSha256": hashlib.sha256(str(error).encode("utf8")).hexdigest()})
        # Failure evidence may use reserved time, never promote success after deadline.
        try:
            if budget.now() < budget.end:
                with (root / "failure.json").open("xb") as output:
                    output.write((json.dumps(receipt, sort_keys=True, allow_nan=False) + "\n").encode("utf8"))
        except BaseException as evidence_error:
            receipt["errors"].append({"stage": "failure-evidence-write", "type": type(evidence_error).__name__,
                "messageSha256": hashlib.sha256(str(evidence_error).encode("utf8")).hexdigest()})
            try:
                sys.stderr.write(json.dumps(receipt, sort_keys=True, allow_nan=False) + "\n")
            except BaseException:
                pass  # Original failure remains the exception observed by the owner.
        raise


if __name__ == "__main__":
    main()
