"""Offline YuNet frame bridge. One bounded JSON request on stdin, one JSON response."""

import base64
import binascii
import hashlib
import importlib.metadata
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
OPENCV_VERSION = "4.13.0"
OPENCV_PACKAGE_VERSION = "4.13.0.92"
MAX_FRAMES = 30
MAX_FRAME_BYTES = 5_000_000
MAX_TOTAL_BYTES = 20_000_000
MAX_JSON_BYTES = 28_000_000
MAX_IMAGE_DIMENSION = 8192
MAX_IMAGE_PIXELS = 20_000_000
MAX_BOXES = 128


def fail(code):
    print(json.dumps({"protocol": "apollo-yunet-cpu-v1", "error": code}), flush=True)
    raise SystemExit(1)


def image_dimensions(raw):
    if raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) >= 24 and raw[12:16] == b"IHDR":
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if raw[:2] == b"\xff\xd8":
        offset = 2
        while offset + 4 <= len(raw):
            if raw[offset] != 0xff:
                raise ValueError("JPEG_HEADER_INVALID")
            marker = raw[offset + 1]
            offset += 2
            if marker in (0xd8, 0xd9):
                continue
            if marker == 0xda:
                break
            size = int.from_bytes(raw[offset:offset + 2], "big")
            if size < 2 or offset + size > len(raw):
                raise ValueError("JPEG_HEADER_INVALID")
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                if size < 7:
                    raise ValueError("JPEG_HEADER_INVALID")
                return int.from_bytes(raw[offset + 5:offset + 7], "big"), int.from_bytes(raw[offset + 3:offset + 5], "big")
            offset += size
    raise ValueError("FRAME_FORMAT_OR_HEADER_UNSUPPORTED")


def detect(detector, frame):
    height, width = frame.shape[:2]
    scale = min(1.0, 640 / max(width, height))
    resized = cv2.resize(frame, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((640, 640, 3), dtype=np.uint8)
    canvas[:resized.shape[0], :resized.shape[1]] = resized
    _, faces = detector.detect(canvas)
    result = []
    for face in ([] if faces is None else faces):
        x, y, w, h = (float(value) for value in face[:4])
        confidence = float(face[-1])
        if not all(math.isfinite(value) for value in (x, y, w, h, confidence)) or w <= 0 or h <= 0 or not 0 <= confidence <= 1:
            raise ValueError("INVALID_DETECTION")
        x1, y1, x2, y2 = x / scale / width, y / scale / height, (x + w) / scale / width, (y + h) / scale / height
        if x2 <= 0 or y2 <= 0 or x1 >= 1 or y1 >= 1:
            raise ValueError("OUTSIDE_FRAME_DETECTION")
        if len(result) >= MAX_BOXES:
            raise ValueError("FACE_BOX_COUNT_LIMIT")
        result.append({"boxXYXY": [max(0.0, x1), max(0.0, y1), min(1.0, x2), min(1.0, y2)], "confidence": confidence, "clipped": x1 < 0 or y1 < 0 or x2 > 1 or y2 > 1})
    return result


def main():
    if len(sys.argv) != 5:
        fail("MODEL_PATH_REQUIRED")
    model_path = Path(sys.argv[1])
    expected_bridge_sha256, expected_python_sha256, expected_opencv_binary_sha256 = sys.argv[2:]
    bridge_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    python_sha256 = hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()
    binary_paths = [path for pattern in ("*.pyd", "*.so") for path in Path(cv2.__file__).parent.glob(pattern)]
    if len(binary_paths) != 1:
        fail("OPENCV_BINARY_AMBIGUOUS")
    opencv_binary_sha256 = hashlib.sha256(binary_paths[0].read_bytes()).hexdigest()
    if bridge_sha256 != expected_bridge_sha256 or python_sha256 != expected_python_sha256 or opencv_binary_sha256 != expected_opencv_binary_sha256:
        fail("RUNTIME_HASH_MISMATCH")
    if not model_path.is_file() or model_path.stat().st_size != 232589 or hashlib.sha256(model_path.read_bytes()).hexdigest() != MODEL_SHA256:
        fail("MODEL_HASH_MISMATCH")
    if cv2.__version__ != OPENCV_VERSION or importlib.metadata.version("opencv-python-headless") != OPENCV_PACKAGE_VERSION:
        fail("OPENCV_VERSION_MISMATCH")
    cv2.setNumThreads(2)
    cv2.ocl.setUseOpenCL(False)
    try:
        payload = sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
        if len(payload) > MAX_JSON_BYTES:
            fail("REQUEST_TOO_LARGE")
        request = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        fail("INVALID_REQUEST_JSON")
    if request.get("protocol") != "apollo-yunet-cpu-v1" or request.get("modelSha256") != MODEL_SHA256:
        fail("INVALID_REQUEST_PROTOCOL")
    source_sha256 = request.get("sourceSha256")
    if not isinstance(source_sha256, str) or len(source_sha256) != 64 or any(char not in "0123456789abcdef" for char in source_sha256):
        fail("INVALID_SOURCE_SHA256")
    frames = request.get("frames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES:
        fail("FRAME_COUNT_OUT_OF_RANGE")
    detector = cv2.FaceDetectorYN_create(str(model_path), "", (640, 640), 0.5, 0.3, 5000, cv2.dnn.DNN_BACKEND_OPENCV, cv2.dnn.DNN_TARGET_CPU)
    results = []
    total = 0
    last_pts = -1
    for entry in frames:
        pts = entry.get("ptsMs")
        if not isinstance(pts, (int, float)) or not math.isfinite(pts) or pts < 0 or pts <= last_pts:
            fail("INVALID_PTS_ORDER")
        last_pts = pts
        try:
            raw = base64.b64decode(entry["bytesBase64"], validate=True)
        except (KeyError, ValueError, binascii.Error):
            fail("INVALID_FRAME_BASE64")
        total += len(raw)
        if not 0 < len(raw) <= MAX_FRAME_BYTES or total > MAX_TOTAL_BYTES or hashlib.sha256(raw).hexdigest() != entry.get("sha256"):
            fail("FRAME_HASH_OR_SIZE_MISMATCH")
        try:
            width, height = image_dimensions(raw)
            if width < 1 or height < 1 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("FRAME_DIMENSION_LIMIT")
            decoded = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
            if decoded is None:
                raise ValueError("FRAME_DECODE_FAILED")
            if decoded.shape[1] != width or decoded.shape[0] != height:
                raise ValueError("FRAME_HEADER_DIMENSIONS_MISMATCH")
            boxes = detect(detector, decoded)
            results.append({"ptsMs": pts, "sha256": entry["sha256"], "status": "observed", "boxes": boxes})
        except cv2.error:
            results.append({"ptsMs": pts, "sha256": entry["sha256"], "status": "unknown", "reason": "FACE_INFERENCE_OR_DECODE_FAILED", "boxes": []})
        except ValueError as error:
            results.append({"ptsMs": pts, "sha256": entry["sha256"], "status": "unknown", "reason": str(error)[:120], "boxes": []})
    print(json.dumps({"protocol": "apollo-yunet-cpu-v1", "sourceSha256": source_sha256, "modelSha256": MODEL_SHA256, "bridgeSha256": bridge_sha256, "pythonSha256": python_sha256, "opencvBinarySha256": opencv_binary_sha256, "opencvVersion": cv2.__version__, "opencvPackageVersion": OPENCV_PACKAGE_VERSION, "backend": "OpenCV DNN CPU", "coverage": "sampled-only", "frames": results}), flush=True)


if __name__ == "__main__":
    main()
