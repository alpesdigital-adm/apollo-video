"""Pure checks of the OpenVINO face-detection-0204 bridge; no OpenVINO, OpenCV, NumPy, model, frame or process.

The decoder is compared with vectors produced by running the OWNER-ACCEPTED V9 provider itself
(tests/fixtures/face0204-v9-provider-vectors.json), the same file the TypeScript decoder is checked against.
Run: python3 -I -S -B tests/v2/openvino-face0204-bridge.test.py
"""
import base64
import hashlib
import importlib.util
import json
import struct
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "src/v2/infrastructure/perception/openvino_face0204_bridge.py"
FIXTURE = ROOT / "tests/fixtures/face0204-v9-provider-vectors.json"

spec = importlib.util.spec_from_file_location("openvino_face0204_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
vectors = json.loads(FIXTURE.read_text(encoding="utf-8"))


def padded(rows):
    rows = list(rows) + [(-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)] * (200 - len(rows))
    return b"".join(struct.pack("<7f", *row) for row in rows)


class Face0204BridgeTest(unittest.TestCase):
    def test_pins_and_policy_identity(self):
        self.assertEqual(bridge.PROTOCOL, "apollo-openvino-face0204-v1")
        self.assertEqual(bridge.MODEL_XML_SHA256, "33394c03a4c88cbcd2537c5d232c149b69f2a7ad406d85d2323d7303f17d7ee3")
        self.assertEqual(bridge.MODEL_BIN_SHA256, "0bbc0e08b297ce385b67ad742fd7612947e855c8f50c625b94835f883a6e4102")
        self.assertEqual((bridge.OUTPUT_BYTES, bridge.OUTPUT_SLOTS, bridge.INPUT_SIZE, bridge.COLLECTION_FLOOR), (5600, 200, 448, 0.2))
        self.assertEqual(vectors["policySha256"], "a3c641fd9f17c07873ce33a6d655001bddbdbed5c4f72351ce9718ee9cacad03")

    def test_equals_the_v9_provider_on_every_vector(self):
        self.assertGreaterEqual(len(vectors["cases"]), 25)
        for case in vectors["cases"]:
            raw = base64.b64decode(case["rawBase64"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), case["rawSha256"], case["name"])
            result = bridge.decode_output(raw, 0.5)
            expected = case["v9"]
            if expected["status"] == "failed":
                self.assertEqual((result["status"], result["reason"], result["slot"]), ("failed", expected["reason"], expected["slot"]), case["name"])
            else:
                self.assertEqual(result["status"], "decoded", case["name"])
                self.assertEqual(result["detections"], expected["detections"], case["name"])

    def test_collection_floor_keeps_the_v9_subset(self):
        for case in vectors["cases"]:
            if case["v9"]["status"] != "decoded":
                continue
            collected = bridge.decode_output(base64.b64decode(case["rawBase64"]), 0.2)
            if collected["status"] == "failed":
                self.assertTrue(case["name"].startswith("low-score-"), case["name"])
                continue
            subset = [item for item in collected["detections"] if item["confidence"] >= 0.5]
            self.assertEqual(subset, case["v9"]["detections"], case["name"])

    def test_invalid_low_score_row_fails_the_frame_at_the_collection_floor_only(self):
        for name in ("low-score-invalid-box-ignored-by-v9", "low-score-nan-box-ignored-by-v9"):
            case = next(item for item in vectors["cases"] if item["name"] == name)
            raw = base64.b64decode(case["rawBase64"])
            self.assertEqual(bridge.decode_output(raw, 0.5)["status"], "decoded")
            strict = bridge.decode_output(raw, 0.2)
            self.assertEqual((strict["status"], strict["slot"]), ("failed", 0))

    def test_malformed_input_fails_closed(self):
        self.assertEqual(bridge.decode_output(b"\x00" * 5599, 0.5)["reason"], "DETECTOR_OUTPUT_SIZE_INVALID")
        self.assertEqual(bridge.decode_output(bytearray(5600), 0.5)["status"], "failed")
        self.assertEqual(bridge.decode_output(padded([]), 1.5)["status"], "failed")
        self.assertEqual(bridge.decode_output(padded([]), 0.5), {"status": "decoded", "detections": []})
        self.assertEqual(bridge.decode_output(bytes(5600), 0.0)["reason"], "DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA")

    def test_png_dimensions_are_read_from_the_header_only(self):
        header = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", 1280, 720) + b"\x08\x02\x00\x00\x00"
        self.assertEqual(bridge.png_dimensions(header), (1280, 720))
        with self.assertRaises(ValueError):
            bridge.png_dimensions(b"\xff\xd8\xff" + b"\x00" * 40)


if __name__ == "__main__":
    unittest.main()
