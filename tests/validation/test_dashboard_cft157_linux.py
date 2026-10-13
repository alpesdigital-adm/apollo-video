"""Synthetic Linux CfT contracts: no HTTP, kernel owner, browser or subprocess."""
from copy import deepcopy
import base64
from email.message import Message
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts/validation/acquire-dashboard-cft157-linux.py"
SPEC = importlib.util.spec_from_file_location("fixed_cft_linux", SOURCE)
actor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(actor)


class Clock:
    def __init__(self):
        self.value = 100.0

    def now(self):
        return self.value

    def budget(self):
        return actor.Budget(340000, now=self.now, wall=self.now)


class Reply:
    def __init__(self, body, url=actor.METADATA_URL):
        self.body = io.BytesIO(body); self.url = url; self.status = 200
        self.headers = {"Content-Length": str(len(body))}; self.closed = False
        self.before_read = lambda: None

    def geturl(self):
        return self.url

    def read(self, count):
        self.before_read()
        return self.body.read(count)

    def close(self):
        self.closed = True


class Opener:
    def __init__(self, reply):
        self.reply = reply; self.calls = []

    def open(self, request, timeout):
        self.calls.append((request.full_url, request.get_method(), timeout))
        return self.reply


def info(name="chrome-linux64/chrome", size=7):
    value = zipfile.ZipInfo(name)
    value.file_size = size; value.compress_size = size; value.external_attr = (stat.S_IFREG | 0o755) << 16
    return value


class Archive:
    def __init__(self, values):
        self.values = values

    def infolist(self):
        return self.values


class LinuxCftContracts(unittest.TestCase):
    def checksum_message(self, *values):
        headers = Message()
        for value in values:
            headers["x-goog-hash"] = value
        return headers

    def test_real_message_reads_repeated_and_combined_checksum_occurrences(self):
        md5, crc = "md5=" + actor.MD5, "crc32c=" + actor.CRC32C
        for values in ((md5, crc), (crc, md5), (md5 + ", " + crc,)):
            headers = self.checksum_message(*values)
            self.assertEqual(headers.get_all("x-goog-hash"), list(values))
            observed = actor.object_checksum_headers(headers)
            self.assertEqual(observed["interface"], "http-message")
            self.assertEqual(observed["occurrenceCount"], len(values))
            self.assertTrue(observed["validated"])
            for raw, fact in zip(values, observed["occurrences"]):
                self.assertEqual(fact["sha256"], hashlib.sha256(raw.encode()).hexdigest())
                self.assertEqual(fact["bytes"], len(raw.encode()))
            self.assertEqual(sorted(component["algorithm"] for occurrence in observed["occurrences"]
                                    for component in occurrence["components"]), ["crc32c", "md5"])
        self.assertEqual(actor.object_checksum_headers({"x-goog-hash": md5 + "," + crc})["interface"], "dict-fixture")

    def test_real_message_duplicate_conflicting_malformed_or_missing_checksums_fail_and_close_without_read(self):
        md5, crc = "md5=" + actor.MD5, "crc32c=" + actor.CRC32C
        fixtures = [(), (md5,), (crc,), (md5, crc, md5), (md5 + "," + crc, crc),
                    ("md5=" + "A" * 22 + "==", crc), (md5, "crc32c=AAAAAA=="),
                    (md5, crc, "md5=wrong"), (md5, crc, ""), (md5 + ",," + crc,),
                    (md5, crc, "sha1=AA=="), (md5 + ", " + crc + ",md5=" + actor.MD5,),
                    (md5, "crc32c=not-base64!"), (md5, crc + "\r\ninjected=value")]
        for values in fixtures:
            with self.subTest(values=values), tempfile.TemporaryDirectory() as temporary:
                reply = Reply(b"", actor.ZIP_URL)
                reply.headers = self.checksum_message(*values)
                reply.headers["Content-Length"] = str(actor.SIZE)
                reply.headers["x-goog-generation"] = actor.GENERATION
                reply.before_read = lambda: self.fail("Rejected checksum headers must never read payload")
                opener = Opener(reply)
                with self.assertRaisesRegex(ValueError, "^CFT_OBJECT_CHECKSUM_HEADERS$") as caught:
                    actor.fetch(actor.ZIP_URL, Path(temporary) / "part", actor.SIZE, Clock().budget(), 90, opener)
                observed = caught.exception.checksum_header_observation
                self.assertEqual(observed["occurrenceCount"], len(values))
                self.assertFalse(observed["validated"]); self.assertTrue(observed["connectionFinallyClosed"])
                self.assertTrue(reply.closed); self.assertEqual(len(opener.calls), 1)
                self.assertFalse((Path(temporary) / "part").exists())
                self.assertNotIn("injected=value", json.dumps(observed))
        with self.assertRaisesRegex(ValueError, "CFT_OBJECT_CHECKSUM_HEADERS"):
            actor.object_checksum_headers(object())  # No arbitrary get/get_all emulation.

    def test_checksum_representation_limits_are_closed_and_arbitrary_text_is_not_persisted(self):
        for headers in (self.checksum_message(*(["md5=" + actor.MD5] * 9)),
                        self.checksum_message("secret=" + "x" * 513),
                        self.checksum_message("secret=credential", "crc32c=" + actor.CRC32C),
                        {"x-goog-hash": 3}):
            with self.subTest(headers=headers), self.assertRaisesRegex(ValueError, "CFT_OBJECT_CHECKSUM_HEADERS") as caught:
                actor.object_checksum_headers(headers)
            self.assertFalse(caught.exception.checksum_header_observation["validated"])
            self.assertNotIn("credential", json.dumps(caught.exception.checksum_header_observation))

    def test_binary_receipt_keeps_observed_checksum_occurrences_and_measured_hashes(self):
        # Tiny controlled payload/pins, not acquired CfT bytes or upstream SHA.
        payload = b"controlled ZIP stand-in"
        expected_md5 = base64.b64encode(hashlib.md5(payload, usedforsecurity=False).digest()).decode()
        for repeated in (True, False):
            reply = Reply(payload, actor.ZIP_URL)
            values = ("md5=" + expected_md5, "crc32c=" + actor.CRC32C)
            reply.headers = self.checksum_message(*(values if repeated else (",".join(values),)))
            reply.headers["Content-Length"] = str(len(payload)); reply.headers["x-goog-generation"] = actor.GENERATION
            with self.subTest(repeated=repeated), tempfile.TemporaryDirectory() as temporary, \
                 patch.object(actor, "SIZE", len(payload)), patch.object(actor, "MD5", expected_md5):
                fact = actor.fetch(actor.ZIP_URL, Path(temporary) / "part", len(payload), Clock().budget(), 90, Opener(reply))
                self.assertEqual(fact["checksumHeaders"]["occurrenceCount"], 2 if repeated else 1)
                self.assertTrue(fact["checksumHeaders"]["validated"])
                self.assertEqual(fact["sha256"], hashlib.sha256(payload).hexdigest())
                self.assertEqual(fact["md5Measured"], expected_md5); self.assertFalse(fact["crc32cCalculated"])
                self.assertTrue(fact["connectionFinallyClosed"]); self.assertTrue(reply.closed)

    def test_official_generation_size_md5_and_crc_are_exact_not_derived_from_current_file(self):
        metadata = {"bucket": "chrome-for-testing-public", "name": "157.0.8090.0/linux64/chrome-linux64.zip",
            "metageneration": "1", "contentType": "application/zip",
            "generation": "1791347120490195", "size": "201551103", "md5Hash": "BvMevHF6ZEenSob5RNSB4g==",
            "crc32c": "SFhLhQ==", "timeCreated": "2026-10-07T04:25:20.561Z"}
        self.assertEqual(actor.validate_metadata(metadata), metadata)
        for key in metadata:
            altered = deepcopy(metadata); altered[key] = "different"
            with self.subTest(key=key), self.assertRaises(ValueError):
                actor.validate_metadata(altered)

    def test_deadline_includes_all_phases_and_never_renews(self):
        clock = Clock(); budget = clock.budget()
        self.assertEqual(budget.end, 340); self.assertEqual(budget.work_end, 310)
        self.assertEqual(budget.phase(90), 190)
        clock.value = 309
        self.assertEqual(budget.phase(90), 310)
        clock.value = 310
        with self.assertRaisesRegex(ValueError, "CFT_DEADLINE"):
            budget.check()
        with self.assertRaisesRegex(ValueError, "ADMISSION"):
            actor.Budget(340000, now=lambda: 310, wall=lambda: 310)

    def test_strict_json_rejects_duplicates_constants_overflow_and_invalid_utf8(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":1e309}', b'{"a":-1e309}', b'"\xff"'):
            with self.subTest(raw=raw), self.assertRaises((ValueError, UnicodeError)):
                actor.strict_json(raw)
        self.assertEqual(actor.strict_json(b'{"finite":0.5}'), {"finite": 0.5})

    def test_download_hashes_received_bytes_and_closes_exact_one_GET(self):
        reply = Reply(b'{"controlled":true}'); opener = Opener(reply)
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "metadata.json"
            facts = actor.fetch(actor.METADATA_URL, destination, 65536, Clock().budget(), 30, opener)
            self.assertEqual(facts["sha256"], hashlib.sha256(destination.read_bytes()).hexdigest())
            self.assertTrue(facts["connectionFinallyClosed"]); self.assertTrue(reply.closed)
            self.assertEqual(opener.calls, [(actor.METADATA_URL, "GET", 30)])
            self.assertFalse(facts["crc32cCalculated"])

    def test_status_redirect_lengths_truncation_and_byte_overflow_fail_without_retry(self):
        changes = [lambda reply: setattr(reply, "status", 206), lambda reply: setattr(reply, "url", "https://other.invalid/"),
            lambda reply: reply.headers.update({"Content-Length": "33"}),
            lambda reply: reply.headers.update({"Content-Length": "1"}),
            lambda reply: reply.headers.update({"Content-Length": "n/a"})]
        for change in changes:
            reply = Reply(b"abcd"); change(reply); opener = Opener(reply)
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(ValueError):
                    actor.fetch(actor.METADATA_URL, Path(temporary) / "part", 4, Clock().budget(), 30, opener)
                self.assertTrue(reply.closed); self.assertEqual(len(opener.calls), 1)
        with self.assertRaisesRegex(ValueError, "REDIRECT"):
            actor.NoRedirect().redirect_request(None, None, 302, "", {}, actor.ZIP_URL)

    def test_late_read_remains_failure_and_connection_closes(self):
        clock = Clock(); budget = clock.budget(); reply = Reply(b"a")
        reply.before_read = lambda: setattr(clock, "value", 131)
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "DEADLINE"):
                actor.fetch(actor.METADATA_URL, Path(temporary) / "part", 65536, budget, 30, Opener(reply))
        self.assertTrue(reply.closed)

    def test_binary_wrong_generation_or_checksum_headers_fail_before_payload_read(self):
        for generation, hashes in [("wrong", "md5=" + actor.MD5 + ",crc32c=" + actor.CRC32C),
                                   (actor.GENERATION, "md5=wrong,crc32c=" + actor.CRC32C)]:
            reply = Reply(b"", actor.ZIP_URL)
            reply.headers = {"Content-Length": "201551103", "x-goog-generation": generation, "x-goog-hash": hashes}
            reply.before_read = lambda: self.fail("Must reject metadata before reading binary")
            with tempfile.TemporaryDirectory() as temporary, self.assertRaises(ValueError):
                actor.fetch(actor.ZIP_URL, Path(temporary) / "part", actor.SIZE, Clock().budget(), 90, Opener(reply))
            self.assertTrue(reply.closed)

    def test_raw_backslash_NUL_and_normalized_names_are_rejected_before_extract(self):
        for raw in ("chrome-linux64\\a", "chrome-linux64/a\0b", "chrome-linux64/../a", "/chrome-linux64/a", "C:/chrome-linux64/a"):
            member = info(); member.orig_filename = raw; member.filename = raw
            if "\0" in raw:
                member.filename = raw.split("\0", 1)[0]
            self.assertEqual(member.orig_filename, raw)
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                actor.archive_members(Archive([info(), member]), Clock().budget(), 190)

    def test_duplicate_file_parent_symlink_SUID_encryption_and_compression_are_rejected(self):
        fixtures = [[info(), info("chrome-linux64/CHROME")], [info(), info("chrome-linux64/chrome/file")]]
        for transform in (lambda value: setattr(value, "external_attr", (stat.S_IFLNK | 0o777) << 16),
                          lambda value: setattr(value, "external_attr", (stat.S_IFREG | 0o4755) << 16),
                          lambda value: setattr(value, "flag_bits", 1), lambda value: setattr(value, "compress_type", zipfile.ZIP_BZIP2)):
            member = info("chrome-linux64/other"); transform(member); fixtures.append([info(), member])
        for fixture in fixtures:
            with self.subTest(fixture=fixture), self.assertRaises(ValueError):
                actor.archive_members(Archive(fixture), Clock().budget(), 190)

    def test_entry_count_expanded_caps_and_missing_chrome_are_rejected(self):
        fixtures = [[info("chrome-linux64/file")], [info(size=actor.ENTRY_LIMIT + 1)],
                    [info()] + [info("chrome-linux64/f" + str(index)) for index in range(2000)],
                    [info(size=actor.ENTRY_LIMIT), info("chrome-linux64/b", actor.ENTRY_LIMIT), info("chrome-linux64/c", actor.ENTRY_LIMIT)]]
        for fixture in fixtures:
            with self.subTest(length=len(fixture)), self.assertRaises(ValueError):
                actor.archive_members(Archive(fixture), Clock().budget(), 190)

    def test_small_real_zip_extract_and_inventory_prove_bytes_not_just_manifest_claims(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); archive = root / "archive.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr(info(), b"fixture")
                non_executable = info("chrome-linux64/resource"); non_executable.external_attr = (stat.S_IFREG | 0o644) << 16
                output.writestr(non_executable, b"data")
            budget = Clock().budget(); actor.extract(archive, root, budget)
            self.assertEqual((root / "chrome-linux64/chrome").read_bytes(), b"fixture")
            self.assertEqual((root / "chrome-linux64/resource").read_bytes(), b"data")
            # Windows chmod does not reproduce Linux mode bits. Only the Linux
            # job can prove that OS readback; every platform still extracts bytes.
            if sys.platform == "linux":
                facts = actor.inventory(root, budget)
                chrome = next(row for row in facts["files"] if row["path"] == "chrome-linux64/chrome")
                self.assertEqual(chrome["sha256"], hashlib.sha256(b"fixture").hexdigest())
                self.assertEqual(facts["totalBytes"], 11); self.assertEqual(facts["fileCount"], 2)

    def test_exclusive_publication_readback_and_deadline_prevent_partial_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); clock = Clock(); budget = clock.budget()
            result = actor.publish(root / "manifest.json", {"outcome": "files-verified-awaiting-owner"}, budget)
            self.assertEqual(result["sha256"], hashlib.sha256((root / "manifest.json").read_bytes()).hexdigest())
            with self.assertRaises(ValueError):
                actor.publish(root / "manifest.json", {}, budget)
            clock.value = 311
            with self.assertRaisesRegex(ValueError, "DEADLINE"):
                actor.publish(root / "late.json", {}, budget)
            self.assertFalse((root / "late.json").exists())


if __name__ == "__main__":
    unittest.main()
