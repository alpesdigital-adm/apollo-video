"""Offline OMZ face-detection-0204 bridge: the owner-accepted V9 policy, one bounded window per process.

stdin: one JSON request naming PNG frames inside one directory (path, SHA-256 and PTS of each). stdout: one JSON
response. The model is read from two pinned files; frames, bridge and interpreter are re-hashed here and again by
the caller. Nothing is downloaded and nothing is written. Third-party modules are imported inside main() so the
pure V9 decoder below can be tested with the standard library alone.

Policy (w62-v9-visible-intersection-continuous/v1, provider policy SHA-256 a3c641fd...cad03): every slot of the
[1,1,200,7] float32 output is walked; image_id -1 is padding; any other slot needs image_id 0, label 0 and a finite
score in [0,1]; a slot at or above the collection floor needs four finite coordinates with xmin < xmax and
ymin < ymax and a strictly positive intersection with the frame, which replaces the box. One invalid selected slot
makes the frame `unknown`; it is never repaired and never an absence of faces.
"""

import base64
import hashlib
import json
import math
import struct
import sys
import time
from pathlib import Path

PROTOCOL = "apollo-openvino-face0204-v1"
MODEL_XML_SHA256 = "33394c03a4c88cbcd2537c5d232c149b69f2a7ad406d85d2323d7303f17d7ee3"
MODEL_BIN_SHA256 = "0bbc0e08b297ce385b67ad742fd7612947e855c8f50c625b94835f883a6e4102"
MODEL_XML_BYTES = 185457
MODEL_BIN_BYTES = 7269196
OUTPUT_BYTES = 5600
OUTPUT_SLOTS = 200
INPUT_SIZE = 448
COLLECTION_FLOOR = 0.2
MAX_FRAMES = 60
MAX_FRAME_BYTES = 8_000_000
MAX_IMAGE_DIMENSION = 8192
MAX_IMAGE_PIXELS = 16_000_000
MAX_REQUEST_BYTES = 1_000_000
EDGES = ("left", "top", "right", "bottom")
HEX = set("0123456789abcdef")


def fail(code):
    print(json.dumps({"protocol": PROTOCOL, "error": code}), flush=True)
    raise SystemExit(1)


def is_number(value):
    return isinstance(value, float) and math.isfinite(value)


def decode_output(raw, floor):
    """Pure V9 decoder. Returns {"status": "decoded", "detections": [...]} or {"status": "failed", "reason", "slot"}."""
    if type(raw) is not bytes or len(raw) != OUTPUT_BYTES or not isinstance(floor, float) or not 0.0 <= floor <= 1.0:
        return {"status": "failed", "reason": "DETECTOR_OUTPUT_SIZE_INVALID", "slot": None}
    detections = []
    for slot, row in enumerate(struct.iter_unpack("<7f", raw)):
        image_id, label, score, *box = row
        if not is_number(image_id):
            return {"status": "failed", "reason": "DETECTOR_IMAGE_ID_INVALID", "slot": slot}
        if image_id == -1.0:
            continue  # Padding of this slot only; never a stop at the first padding.
        if image_id != 0.0:
            return {"status": "failed", "reason": "DETECTOR_IMAGE_ID_INVALID", "slot": slot}
        if not is_number(label) or label != 0.0:
            return {"status": "failed", "reason": "DETECTOR_LABEL_INVALID", "slot": slot}
        if not is_number(score) or score < 0.0 or score > 1.0:
            return {"status": "failed", "reason": "DETECTOR_SCORE_INVALID", "slot": slot}
        if score < floor:
            continue
        if not all(is_number(value) for value in box):
            return {"status": "failed", "reason": "DETECTOR_FACE_BOX_NONFINITE_OR_SHAPE", "slot": slot}
        xmin, ymin, xmax, ymax = box
        if not (xmin < xmax and ymin < ymax):
            return {"status": "failed", "reason": "DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA", "slot": slot}
        visible = [max(0.0, xmin), max(0.0, ymin), min(1.0, xmax), min(1.0, ymax)]
        if not (0.0 <= visible[0] < visible[2] <= 1.0 and 0.0 <= visible[1] < visible[3] <= 1.0):
            return {"status": "failed", "reason": "DETECTOR_FACE_BOX_EMPTY_INTERSECTION", "slot": slot}
        changes = [edge for edge, original, projected in zip(EDGES, (xmin, ymin, xmax, ymax), visible) if original != projected]
        detections.append({"slotIndex": slot, "confidence": score, "rawXYXY": [xmin, ymin, xmax, ymax],
                           "boxXYXY": visible, "clipped": bool(changes), "boundaryChanges": changes})
    return {"status": "decoded", "detections": detections}


def png_dimensions(raw):
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR":
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    raise ValueError("FRAME_FORMAT_UNSUPPORTED")


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_request():
    payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(payload) > MAX_REQUEST_BYTES:
        fail("REQUEST_TOO_LARGE")
    try:
        request = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        fail("INVALID_REQUEST_JSON")
    if not isinstance(request, dict) or request.get("protocol") != PROTOCOL:
        fail("INVALID_REQUEST_PROTOCOL")
    source = request.get("sourceSha256")
    if not isinstance(source, str) or len(source) != 64 or any(char not in HEX for char in source):
        fail("INVALID_SOURCE_SHA256")
    directory = request.get("framesDirectory")
    frames = request.get("frames")
    if not isinstance(directory, str) or not Path(directory).is_absolute() or not Path(directory).is_dir():
        fail("INVALID_FRAMES_DIRECTORY")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES:
        fail("FRAME_COUNT_OUT_OF_RANGE")
    last = -1
    root = Path(directory).resolve()
    for entry in frames:
        pts = entry.get("ptsMs") if isinstance(entry, dict) else None
        name = entry.get("file") if isinstance(entry, dict) else None
        digest = entry.get("sha256") if isinstance(entry, dict) else None
        if type(pts) not in (int, float) or not math.isfinite(pts) or pts < 0 or pts <= last:
            fail("INVALID_PTS_ORDER")
        last = pts
        if (not isinstance(name, str) or len(name) > 64 or "/" in name or "\\" in name or not name.endswith(".png") or
                not isinstance(digest, str) or len(digest) != 64 or any(char not in HEX for char in digest)):
            fail("INVALID_FRAME_ENTRY")
        path = root / name
        if path.is_symlink() or path.resolve().parent != root or not path.is_file():
            fail("FRAME_PATH_REJECTED")
    return source, root, frames


def main():
    if len(sys.argv) != 5:
        fail("ARGUMENTS_REQUIRED")
    model_xml, model_bin = Path(sys.argv[1]), Path(sys.argv[2])
    expected_bridge, expected_python = sys.argv[3], sys.argv[4]
    bridge_sha256 = sha256_file(__file__)
    python_sha256 = sha256_file(sys.executable)
    if bridge_sha256 != expected_bridge or python_sha256 != expected_python:
        fail("RUNTIME_HASH_MISMATCH")
    for path, size, digest in ((model_xml, MODEL_XML_BYTES, MODEL_XML_SHA256), (model_bin, MODEL_BIN_BYTES, MODEL_BIN_SHA256)):
        if not path.is_file() or path.stat().st_size != size or sha256_file(path) != digest:
            fail("MODEL_HASH_MISMATCH")
    if sys.byteorder != "little":
        fail("SYSTEM_BYTE_ORDER_UNSUPPORTED")
    source_sha256, root, frames = read_request()

    import importlib.metadata
    import cv2
    import numpy as np
    import openvino as ov

    cv2.setNumThreads(2)
    cv2.ocl.setUseOpenCL(False)
    core = ov.Core()
    model = core.read_model(str(model_xml), str(model_bin))
    compiled = core.compile_model(model, "CPU", {"INFERENCE_NUM_THREADS": 2, "NUM_STREAMS": "1",
                                                "PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": ov.Type.f32})
    if (list(compiled.input(0).shape) != [1, 3, INPUT_SIZE, INPUT_SIZE] or list(compiled.output(0).shape) != [1, 1, OUTPUT_SLOTS, 7] or
            compiled.input(0).get_element_type().get_type_name() != "f32" or compiled.output(0).get_element_type().get_type_name() != "f32" or
            compiled.get_property("INFERENCE_NUM_THREADS") != 2 or str(compiled.get_property("NUM_STREAMS")) != "1" or
            list(compiled.get_property("EXECUTION_DEVICES")) != ["CPU"]):
        fail("DETECTOR_CPU_CONFIG_INVALID")
    request = compiled.create_infer_request()
    runtime = {"platform": sys.platform, "pythonVersion": "%d.%d" % sys.version_info[:2],
               "openvinoVersion": ov.get_version(), "openvinoPackageVersion": importlib.metadata.version("openvino"),
               "opencvVersion": cv2.__version__, "numpyVersion": np.__version__}

    results = []
    started = time.perf_counter()
    for entry in frames:
        base = {"ptsMs": entry["ptsMs"], "file": entry["file"], "sha256": entry["sha256"]}
        try:
            raw_png = (root / entry["file"]).read_bytes()
            if not 0 < len(raw_png) <= MAX_FRAME_BYTES or hashlib.sha256(raw_png).hexdigest() != entry["sha256"]:
                raise ValueError("FRAME_HASH_OR_SIZE_MISMATCH")
            width, height = png_dimensions(raw_png)
            if width < 1 or height < 1 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("FRAME_DIMENSION_LIMIT")
            frame = cv2.imdecode(np.frombuffer(raw_png, dtype=np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
            if frame is None or frame.dtype != np.uint8 or list(frame.shape) != [height, width, 3]:
                raise ValueError("FRAME_DECODE_FAILED")
            resized = cv2.resize(frame, (INPUT_SIZE, INPUT_SIZE), interpolation=cv2.INTER_LINEAR)
            blob = np.ascontiguousarray(resized.transpose(2, 0, 1)[None], dtype=np.float32)
            infer_started = time.perf_counter_ns()
            request.infer({compiled.input(0): blob})
            infer_ms = (time.perf_counter_ns() - infer_started) / 1e6
            output = np.asarray(request.get_output_tensor(0).data)
            if list(output.shape) != [1, 1, OUTPUT_SLOTS, 7] or str(output.dtype) != "float32" or output.dtype.byteorder not in ("<", "="):
                raise ValueError("DETECTOR_OUTPUT_TENSOR_INVALID")
            raw_output = output.tobytes(order="C")
            decoded = decode_output(raw_output, COLLECTION_FLOOR)
            record = dict(base, width=width, height=height, inferMs=infer_ms,
                          rawOutputBase64=base64.b64encode(raw_output).decode("ascii"),
                          rawOutputSha256=hashlib.sha256(raw_output).hexdigest())
            if decoded["status"] == "failed":
                results.append(dict(record, status="unknown", reason=decoded["reason"], failedSlot=decoded["slot"], detections=[]))
            else:
                results.append(dict(record, status="observed", reason=None, failedSlot=None, detections=decoded["detections"]))
        except (ValueError, OSError) as error:
            results.append(dict(base, status="unknown", reason=str(error)[:100] if isinstance(error, ValueError) else "FRAME_READ_FAILED",
                                width=None, height=None, inferMs=None, rawOutputBase64=None, rawOutputSha256=None,
                                failedSlot=None, detections=[]))
        except (cv2.error, RuntimeError):
            results.append(dict(base, status="unknown", reason="FACE_INFERENCE_FAILED", width=None, height=None, inferMs=None,
                                rawOutputBase64=None, rawOutputSha256=None, failedSlot=None, detections=[]))
    print(json.dumps({"protocol": PROTOCOL, "sourceSha256": source_sha256, "bridgeSha256": bridge_sha256,
                      "pythonSha256": python_sha256, "modelXmlSha256": MODEL_XML_SHA256, "modelBinSha256": MODEL_BIN_SHA256,
                      "outputPolicyId": "w62-v9-visible-intersection-continuous/v1", "collectionFloor": COLLECTION_FLOOR,
                      "runtime": runtime, "coverage": "sampled-only", "elapsedMs": (time.perf_counter() - started) * 1000.0,
                      "frames": results}), flush=True)


if __name__ == "__main__":
    main()
