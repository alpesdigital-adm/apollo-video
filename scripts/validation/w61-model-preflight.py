"""Bounded, offline YuNet CPU load/latency smoke test; no accuracy claim."""

import argparse
import ctypes
import hashlib
import json
import os
import platform
import statistics
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort


EXPECTED_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
EXPECTED_BYTES = 232589


def working_set_bytes():
    if os.name != "nt":
        return None
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    counters = Counters()
    counters.cb = ctypes.sizeof(Counters)
    get_current = ctypes.windll.kernel32.GetCurrentProcess
    get_current.restype = ctypes.c_void_p
    get_info = ctypes.windll.psapi.GetProcessMemoryInfo
    get_info.argtypes = (ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong)
    get_info.restype = ctypes.c_int
    handle = get_current()
    if not get_info(handle, ctypes.byref(counters), counters.cb):
        raise OSError("GetProcessMemoryInfo failed")
    return counters.WorkingSetSize


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raw = args.model.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if len(raw) != EXPECTED_BYTES or digest != EXPECTED_SHA256:
        raise SystemExit("MODEL_HASH_OR_SIZE_MISMATCH")

    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    initial_rss = working_set_bytes()
    start = time.monotonic()
    session = ort.InferenceSession(str(args.model), options, providers=["CPUExecutionProvider"])
    frame = np.zeros((1, 3, 640, 640), dtype=np.float32)
    times = []
    peak_rss = working_set_bytes()
    for index in range(33):
        if time.monotonic() - start > 30:
            raise SystemExit("MODEL_SPIKE_TIMEOUT")
        before = time.perf_counter()
        outputs = session.run(None, {"input": frame})
        elapsed_ms = (time.perf_counter() - before) * 1000
        if not all(np.isfinite(output).all() for output in outputs):
            raise SystemExit("MODEL_NONFINITE_OUTPUT")
        current_rss = working_set_bytes()
        if current_rss is not None:
            peak_rss = max(peak_rss, current_rss)
        if index >= 3:
            times.append(elapsed_ms)

    timings = sorted(times)
    result = {
        "status": "latency_smoke_only",
        "modelSha256": digest,
        "modelBytes": len(raw),
        "modelPath": str(args.model),
        "providers": session.get_providers(),
        "python": platform.python_version(),
        "onnxruntime": ort.__version__,
        "cpu": platform.processor(),
        "os": platform.platform(),
        "threads": {"intra": 2, "inter": 1},
        "input": "zero float32 tensor 1x3x640x640; not a face/accuracy test",
        "warmupRuns": 3,
        "measuredRuns": 30,
        "medianMs": statistics.median(times),
        "p95Ms": timings[28],
        "totalSeconds": time.monotonic() - start,
        "latencyGate": statistics.median(times) <= 150 and timings[28] <= 500,
        "initialRssBytes": initial_rss,
        "peakRssBytes": peak_rss,
        "additionalPeakRssBytes": peak_rss - initial_rss if peak_rss is not None and initial_rss is not None else None,
        "rssGate": peak_rss - initial_rss <= 512 * 1024 * 1024 if peak_rss is not None and initial_rss is not None else "unmeasured",
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
