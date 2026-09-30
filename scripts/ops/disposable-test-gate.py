"""Fail-closed unittest gate for disposable, local operations checks."""

import argparse
from contextlib import redirect_stderr, redirect_stdout
import gc
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import unittest
import warnings


_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def test_id(test):
    """Only emit structural identifiers, never descriptions, subtest args or exceptions."""
    parts = (*type(test).__module__.split("."), type(test).__name__, getattr(test, "_testMethodName", "runTest"))
    return ".".join(part if _IDENTIFIER.fullmatch(part) else "unknown" for part in parts)


class GateResult(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.linux_started = 0
        self.linux_skipped = 0
        self.linux_failed = False

    def startTest(self, test):
        super().startTest(test)
        if type(test).__module__ == "test_bootstrap_linux":
            self.linux_started += 1

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        if type(test).__module__ == "test_bootstrap_linux":
            self.linux_skipped += 1

    def addFailure(self, test, err):
        super().addFailure(test, err)
        if type(test).__module__ == "test_bootstrap_linux":
            self.linux_failed = True

    def addError(self, test, err):
        super().addError(test, err)
        if type(test).__module__ == "test_bootstrap_linux":
            self.linux_failed = True


def run_suite(suite, *, platform_name=None, start_dir=None):
    platform_name = platform_name or sys.platform
    result = GateResult()
    thread_errors = 0
    uncaught_errors = 0
    previous_thread_hook = threading.excepthook
    previous_unraisable_hook = sys.unraisablehook

    def count_thread_error(_args):
        nonlocal thread_errors
        thread_errors += 1

    def count_unraisable_error(_args):
        nonlocal uncaught_errors
        uncaught_errors += 1

    before = set(threading.enumerate())
    threading.excepthook = count_thread_error
    sys.unraisablehook = count_unraisable_error
    lingering = False
    try:
        # Neither test output nor exception arguments may enter CI logs.
        with open(os.devnull, "w", encoding="utf-8") as discard:
            with redirect_stdout(discard), redirect_stderr(discard), warnings.catch_warnings():
                warnings.simplefilter("error", ResourceWarning)
                if start_dir is not None:
                    suite = unittest.TestLoader().discover(str(start_dir), pattern="test_*.py")
                suite.run(result)
                deadline = time.monotonic() + 1
                for thread in set(threading.enumerate()) - before:
                    thread.join(timeout=max(0, deadline - time.monotonic()))
                lingering = any(thread.is_alive() for thread in set(threading.enumerate()) - before)
                gc.collect()  # Trigger delayed finalizers while unraisablehook is installed.
    finally:
        threading.excepthook = previous_thread_hook
        sys.unraisablehook = previous_unraisable_hook
    linux_executed = result.linux_started - result.linux_skipped
    linux_status = ("not-run" if linux_executed == 0 else
                    "failed" if result.linux_failed or result.linux_skipped else "passed")
    return {
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skips": len(result.skipped),
        "failedTestIds": sorted({test_id(test) for test, _ in result.failures + result.errors}),
        "skippedTestIds": sorted({test_id(test) for test, _ in result.skipped}),
        "threadErrors": thread_errors,
        "uncaughtErrors": uncaught_errors,
        "lingeringThreads": int(lingering),
        "platform": platform_name,
        "linuxSmoke": {"status": linux_status, "tests": linux_executed, "skips": result.linux_skipped},
        "success": result.wasSuccessful() and result.testsRun > 0 and thread_errors == 0 and uncaught_errors == 0 and not lingering,
    }


def run_discovered(start_dir):
    return run_suite(None, start_dir=start_dir)


def empty_report():
    return {
        "tests": 0, "failures": 0, "errors": 1, "skips": 0,
        "failedTestIds": [], "skippedTestIds": [],
        "threadErrors": 0, "uncaughtErrors": 0, "lingeringThreads": 0,
        "platform": sys.platform, "linuxSmoke": {"status": "not-run", "tests": 0, "skips": 0},
        "success": False,
    }


def accept_report(report, *, require_linux=False):
    smoke = report["linuxSmoke"]
    return report["success"] and (not require_linux or (
        report["platform"].startswith("linux") and smoke["status"] == "passed"
        and smoke["tests"] > 0 and smoke["skips"] == 0
    ))


def main():
    parser = argparse.ArgumentParser(description="Run disposable local operations tests (100 s process limit via Node wrapper).")
    parser.add_argument("--require-linux", action="store_true", help="Refuse any non-Linux host before test discovery")
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        print(json.dumps(empty_report()))
        print("Python 3.12 or newer is required.", file=sys.stderr)
        return 1
    if args.require_linux and not sys.platform.startswith("linux"):
        report = empty_report()
        print(json.dumps(report))
        print("Linux required; no tests executed.", file=sys.stderr)
        return 1
    try:
        report = run_discovered(Path(__file__).resolve().parents[2] / "tests/ops")
    except Exception:
        report = empty_report()
        print("Test discovery/execution failed (details withheld).", file=sys.stderr)
    print(json.dumps(report))
    return 0 if accept_report(report, require_linux=args.require_linux) else 1


if __name__ == "__main__":
    sys.exit(main())
