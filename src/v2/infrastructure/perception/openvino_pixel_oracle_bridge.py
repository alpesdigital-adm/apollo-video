"""Offline pixel oracle bridge for the W67 MP4 critic: two OMZ face detectors and a feature-based frame registration.

stdin: one JSON request naming PNG frames inside one directory (path name, SHA-256) and the (source, output) pairs to register.
stdout: one JSON response. The two models are read from four pinned files; frames, bridge and interpreter are re-hashed here and again by
the caller. Nothing is downloaded and nothing is written. Third-party modules are imported inside main().

The bridge returns the RAW detector tensors (base64). It decides nothing about faces: the caller decodes them with its own twin of the
V9 output policy, so a bridge that disagrees with the policy cannot publish a box.

Operating points (never tuned here):
  - face-detection-0204 (V9):         BGR, direct INTER_LINEAR resize to 448x448, NCHW float32.
  - face-detection-retail-0004 (V7):  BGR, direct INTER_LINEAR resize to 300x300, NCHW float32.

Registration (`orb-2000-ratio0.75-similarity-ransac3px/v1`): ORB(2000) keypoints on the grayscale source and output frames, Hamming
k=2 matches kept at ratio 0.75, similarity transform (scale + rotation + translation) by RANSAC at 3 px, OpenCV RNG seeded with 0.
"""

import base64
import hashlib
import json
import math
import sys
import time
from pathlib import Path

PROTOCOL = "apollo-pixel-oracle/v1"
MODELS = {
    "v9": {"xml_bytes": 185457, "bin_bytes": 7269196, "input": 448,
           "xml_sha256": "33394c03a4c88cbcd2537c5d232c149b69f2a7ad406d85d2323d7303f17d7ee3",
           "bin_sha256": "0bbc0e08b297ce385b67ad742fd7612947e855c8f50c625b94835f883a6e4102"},
    "retail": {"xml_bytes": 105340, "bin_bytes": 2352984, "input": 300,
               "xml_sha256": "90922d199016d18128bdaba488bdb1628fce50efcc81155ede7949cbba3dd979",
               "bin_sha256": "89349ce12dd21c5263fb302cd3ffd4b73c35ea12ed98aff863d03a2cf3a32464"},
}
OUTPUT_BYTES = 5600
OUTPUT_SLOTS = 200
MAX_FRAMES = 200
MAX_PAIRS = 200
MAX_FRAME_BYTES = 16_000_000
MAX_IMAGE_DIMENSION = 8192
MAX_IMAGE_PIXELS = 16_000_000
MAX_REQUEST_BYTES = 2_000_000
HEX = set("0123456789abcdef")


def fail(code):
    print(json.dumps({"protocol": PROTOCOL, "error": code}), flush=True)
    raise SystemExit(1)


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def is_hex64(value):
    return isinstance(value, str) and len(value) == 64 and all(char in HEX for char in value)


def png_dimensions(raw):
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR":
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    raise ValueError("FRAME_FORMAT_UNSUPPORTED")


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
    directory = request.get("framesDirectory")
    frames = request.get("frames")
    pairs = request.get("pairs", [])
    if not isinstance(directory, str) or not Path(directory).is_absolute() or not Path(directory).is_dir():
        fail("INVALID_FRAMES_DIRECTORY")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES:
        fail("FRAME_COUNT_OUT_OF_RANGE")
    if not isinstance(pairs, list) or len(pairs) > MAX_PAIRS:
        fail("PAIR_COUNT_OUT_OF_RANGE")
    root = Path(directory).resolve()
    ids = set()
    for entry in frames:
        ident = entry.get("id") if isinstance(entry, dict) else None
        name = entry.get("file") if isinstance(entry, dict) else None
        digest = entry.get("sha256") if isinstance(entry, dict) else None
        if (not isinstance(ident, str) or not 1 <= len(ident) <= 80 or ident in ids or not isinstance(name, str) or len(name) > 80 or
                "/" in name or "\\" in name or not name.endswith(".png") or not is_hex64(digest)):
            fail("INVALID_FRAME_ENTRY")
        ids.add(ident)
        path = root / name
        if path.is_symlink() or path.resolve().parent != root or not path.is_file():
            fail("FRAME_PATH_REJECTED")
    for pair in pairs:
        if (not isinstance(pair, dict) or not isinstance(pair.get("id"), str) or pair.get("sourceId") not in ids or
                pair.get("outputId") not in ids):
            fail("INVALID_PAIR_ENTRY")
    return root, frames, pairs


def compile_model(ov, model_dir, key, filename):
    spec = MODELS[key]
    xml, binary = Path(model_dir) / (filename + ".xml"), Path(model_dir) / (filename + ".bin")
    for path, size, digest in ((xml, spec["xml_bytes"], spec["xml_sha256"]), (binary, spec["bin_bytes"], spec["bin_sha256"])):
        if not path.is_file() or path.stat().st_size != size or sha256_file(path) != digest:
            fail("MODEL_HASH_MISMATCH")
    core = ov.Core()
    model = core.read_model(str(xml), str(binary))
    compiled = core.compile_model(model, "CPU", {"INFERENCE_NUM_THREADS": 2, "NUM_STREAMS": "1",
                                                "PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": ov.Type.f32})
    size = spec["input"]
    if (list(compiled.input(0).shape) != [1, 3, size, size] or list(compiled.output(0).shape) != [1, 1, OUTPUT_SLOTS, 7] or
            compiled.input(0).get_element_type().get_type_name() != "f32" or
            compiled.get_property("INFERENCE_NUM_THREADS") != 2 or str(compiled.get_property("NUM_STREAMS")) != "1" or
            list(compiled.get_property("EXECUTION_DEVICES")) != ["CPU"]):
        fail("DETECTOR_CPU_CONFIG_INVALID")
    return compiled, compiled.create_infer_request()


def infer(cv2, np, request, compiled, frame, size):
    resized = cv2.resize(frame, (size, size), interpolation=cv2.INTER_LINEAR)
    blob = np.ascontiguousarray(resized.transpose(2, 0, 1)[None], dtype=np.float32)
    started = time.perf_counter_ns()
    request.infer({compiled.input(0): blob})
    infer_ms = (time.perf_counter_ns() - started) / 1e6
    output = np.asarray(request.get_output_tensor(0).data)
    if list(output.shape) != [1, 1, OUTPUT_SLOTS, 7] or str(output.dtype) != "float32" or output.dtype.byteorder not in ("<", "="):
        raise ValueError("DETECTOR_OUTPUT_TENSOR_INVALID")
    raw = output.tobytes(order="C")
    if len(raw) != OUTPUT_BYTES:
        raise ValueError("DETECTOR_OUTPUT_SIZE_INVALID")
    return {"rawOutputBase64": base64.b64encode(raw).decode("ascii"), "rawOutputSha256": hashlib.sha256(raw).hexdigest(), "inferMs": infer_ms}


def register(cv2, np, source_bgr, output_bgr):
    """Similarity registration of the source frame onto the output frame, measured on pixels only."""
    cv2.setRNGSeed(0)
    orb = cv2.ORB_create(nfeatures=2000, scaleFactor=1.2, nlevels=8, edgeThreshold=15, patchSize=31, fastThreshold=10)
    source = cv2.cvtColor(source_bgr, cv2.COLOR_BGR2GRAY)
    output = cv2.cvtColor(output_bgr, cv2.COLOR_BGR2GRAY)
    keypoints_s, descriptors_s = orb.detectAndCompute(source, None)
    keypoints_o, descriptors_o = orb.detectAndCompute(output, None)
    base = {"status": "failed", "reason": None, "matches": 0, "inliers": 0, "matrix": None, "medianResidualPixels": None,
            "scale": None, "rotationDegrees": None, "keypointsSource": len(keypoints_s or []), "keypointsOutput": len(keypoints_o or [])}
    if descriptors_s is None or descriptors_o is None or len(keypoints_s) < 8 or len(keypoints_o) < 8:
        return dict(base, reason="TOO_FEW_KEYPOINTS")
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    good = []
    for pair in matcher.knnMatch(descriptors_s, descriptors_o, k=2):
        if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance:
            good.append(pair[0])
    if len(good) < 8:
        return dict(base, reason="TOO_FEW_MATCHES", matches=len(good))
    points_s = np.float32([keypoints_s[m.queryIdx].pt for m in good])
    points_o = np.float32([keypoints_o[m.trainIdx].pt for m in good])
    matrix, inliers = cv2.estimateAffinePartial2D(points_s, points_o, method=cv2.RANSAC, ransacReprojThreshold=3.0,
                                                  maxIters=5000, confidence=0.995, refineIters=20)
    if matrix is None or inliers is None:
        return dict(base, reason="NO_TRANSFORM", matches=len(good))
    mask = inliers.ravel().astype(bool)
    count = int(mask.sum())
    mapped = points_s[mask] @ matrix[:, :2].T + matrix[:, 2]
    residuals = np.linalg.norm(mapped - points_o[mask], axis=1)
    scale = math.hypot(float(matrix[0, 0]), float(matrix[1, 0]))
    rotation = math.degrees(math.atan2(float(matrix[1, 0]), float(matrix[0, 0])))
    return dict(base, status="ok", matches=len(good), inliers=count, matrix=[[float(v) for v in row] for row in matrix],
                medianResidualPixels=float(np.median(residuals)) if count else None, scale=scale, rotationDegrees=rotation)


def main():
    if len(sys.argv) != 5:
        fail("ARGUMENTS_REQUIRED")
    v9_dir, retail_dir, expected_bridge, expected_python = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    bridge_sha256 = sha256_file(__file__)
    python_sha256 = sha256_file(sys.executable)
    if bridge_sha256 != expected_bridge or python_sha256 != expected_python:
        fail("RUNTIME_HASH_MISMATCH")
    if sys.byteorder != "little":
        fail("SYSTEM_BYTE_ORDER_UNSUPPORTED")
    root, frames, pairs = read_request()

    import importlib.metadata
    import cv2
    import numpy as np
    import openvino as ov

    cv2.setNumThreads(2)
    cv2.ocl.setUseOpenCL(False)
    v9, v9_request = compile_model(ov, v9_dir, "v9", "face-detection-0204")
    retail, retail_request = compile_model(ov, retail_dir, "retail", "face-detection-retail-0004")
    runtime = {"platform": sys.platform, "pythonVersion": "%d.%d" % sys.version_info[:2], "openvinoVersion": ov.get_version(),
               "openvinoPackageVersion": importlib.metadata.version("openvino"), "opencvVersion": cv2.__version__, "numpyVersion": np.__version__}
    started = time.perf_counter()
    decoded = {}
    results = []
    for entry in frames:
        base = {"id": entry["id"], "file": entry["file"], "sha256": entry["sha256"]}
        try:
            raw_png = (root / entry["file"]).read_bytes()
            if not 0 < len(raw_png) <= MAX_FRAME_BYTES or hashlib.sha256(raw_png).hexdigest() != entry["sha256"]:
                raise ValueError("FRAME_HASH_OR_SIZE_MISMATCH")
            width, height = png_dimensions(raw_png)
            if width < 2 or height < 2 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("FRAME_DIMENSION_LIMIT")
            frame = cv2.imdecode(np.frombuffer(raw_png, dtype=np.uint8), cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
            if frame is None or frame.dtype != np.uint8 or list(frame.shape) != [height, width, 3]:
                raise ValueError("FRAME_DECODE_FAILED")
            decoded[entry["id"]] = frame
            record = dict(base, status="ok", reason=None, width=width, height=height)
            for key, compiled, request in (("v9", v9, v9_request), ("retail", retail, retail_request)):
                try:
                    record[key] = infer(cv2, np, request, compiled, frame, MODELS[key]["input"])
                except (ValueError, RuntimeError, cv2.error):
                    record[key] = {"rawOutputBase64": None, "rawOutputSha256": None, "inferMs": None, "reason": "FACE_INFERENCE_FAILED"}
            results.append(record)
        except (ValueError, OSError) as error:
            results.append(dict(base, status="error", reason=str(error)[:100] if isinstance(error, ValueError) else "FRAME_READ_FAILED",
                                width=None, height=None))
        except (cv2.error, RuntimeError):
            results.append(dict(base, status="error", reason="FRAME_PROCESSING_FAILED", width=None, height=None))
    registrations = []
    for pair in pairs:
        source, output = decoded.get(pair["sourceId"]), decoded.get(pair["outputId"])
        if source is None or output is None:
            registrations.append({"id": pair["id"], "sourceId": pair["sourceId"], "outputId": pair["outputId"], "status": "failed", "reason": "FRAME_UNAVAILABLE"})
            continue
        try:
            registrations.append(dict(register(cv2, np, source, output), id=pair["id"], sourceId=pair["sourceId"], outputId=pair["outputId"]))
        except (ValueError, cv2.error):
            registrations.append({"id": pair["id"], "sourceId": pair["sourceId"], "outputId": pair["outputId"], "status": "failed", "reason": "REGISTRATION_ERROR"})
    print(json.dumps({"protocol": PROTOCOL, "bridgeSha256": bridge_sha256, "pythonSha256": python_sha256,
                      "models": {key: {"xmlSha256": spec["xml_sha256"], "binSha256": spec["bin_sha256"], "inputSize": spec["input"]} for key, spec in MODELS.items()},
                      "runtime": runtime, "elapsedMs": (time.perf_counter() - started) * 1000.0, "frames": results,
                      "registrations": registrations}), flush=True)


if __name__ == "__main__":
    main()
