"""Isolated behavioral checks for the disposable, local-only unittest gate."""

import gc
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import warnings
from pathlib import Path


GATE = Path(__file__).resolve().parents[2] / "scripts/ops/disposable-test-gate.py"
WRAPPER = GATE.with_name("run-disposable-validation-tests.mjs")
SPEC = importlib.util.spec_from_file_location("disposable_gate_under_test", GATE)
assert SPEC is not None and SPEC.loader is not None
GATE_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE_MODULE)


class DisposableGateTests(unittest.TestCase):
    def test_injected_passing_suite_reports_one_test_and_no_async_errors(self):
        class Passing(unittest.TestCase):
            def runTest(self):
                self.assertTrue(True)

        report = GATE_MODULE.run_suite(unittest.TestSuite([Passing()]), platform_name=sys.platform)
        self.assertEqual(report["tests"], 1)
        self.assertEqual(report["failures"], 0)
        self.assertEqual(report["errors"], 0)
        self.assertEqual(report["skips"], 0)
        self.assertEqual(report["threadErrors"], 0)
        self.assertEqual(report["uncaughtErrors"], 0)
        self.assertEqual(report["platform"], sys.platform)
        self.assertEqual(report["linuxSmoke"], {"status": "not-run", "tests": 0, "skips": 0})
        self.assertTrue(report["success"])

    def test_failing_suite_does_not_pass(self):
        class Failing(unittest.TestCase):
            def runTest(self):
                self.fail("synthetic failure")

        report = GATE_MODULE.run_suite(unittest.TestSuite([Failing()]))
        self.assertEqual((report["tests"], report["failures"], report["errors"]), (1, 1, 0))
        self.assertFalse(report["success"])

    def test_failure_and_skip_ids_are_controlled_and_never_include_exception_text(self):
        class Failing(unittest.TestCase):
            def runTest(self):
                self.fail("secret-from-failure")

        class Skipped(unittest.TestCase):
            @unittest.skip("secret-from-skip")
            def runTest(self):
                pass

        report = GATE_MODULE.run_suite(unittest.TestSuite([Failing(), Skipped()]))
        self.assertEqual(report["failedTestIds"], [f"{__name__}.Failing.runTest"])
        self.assertEqual(report["skippedTestIds"], [f"{__name__}.Skipped.runTest"])
        self.assertNotIn("secret-from", json.dumps(report))

    def test_linux_without_smoke_cases_is_not_proof(self):
        class Other(unittest.TestCase):
            def runTest(self):
                pass

        report = GATE_MODULE.run_suite(unittest.TestSuite([Other()]), platform_name="linux")
        self.assertEqual(report["linuxSmoke"], {"status": "not-run", "tests": 0, "skips": 0})
        self.assertFalse(GATE_MODULE.accept_report(report, require_linux=True))

    def test_linux_skipped_smoke_is_not_proof(self):
        class Smoke(unittest.TestCase):
            @unittest.skip("no smoke")
            def runTest(self):
                pass

        Smoke.__module__ = "test_bootstrap_linux"
        report = GATE_MODULE.run_suite(unittest.TestSuite([Smoke()]), platform_name="linux")
        self.assertEqual(report["linuxSmoke"], {"status": "not-run", "tests": 0, "skips": 1})
        self.assertIn("test_bootstrap_linux.Smoke.runTest", report["skippedTestIds"])
        self.assertFalse(GATE_MODULE.accept_report(report, require_linux=True))

    def test_linux_smoke_pass_and_failure_are_distinguished(self):
        class Smoke(unittest.TestCase):
            def runTest(self):
                pass

        class Broken(unittest.TestCase):
            def runTest(self):
                self.fail("private")

        Smoke.__module__ = Broken.__module__ = "test_bootstrap_linux"
        passed = GATE_MODULE.run_suite(unittest.TestSuite([Smoke()]), platform_name="linux")
        failed = GATE_MODULE.run_suite(unittest.TestSuite([Smoke(), Broken()]), platform_name="linux")
        self.assertEqual(passed["linuxSmoke"], {"status": "passed", "tests": 1, "skips": 0})
        self.assertTrue(GATE_MODULE.accept_report(passed, require_linux=True))
        self.assertEqual(failed["linuxSmoke"], {"status": "failed", "tests": 2, "skips": 0})
        self.assertFalse(GATE_MODULE.accept_report(failed, require_linux=True))

    def test_finalizer_warning_is_collected_within_gate(self):
        class Finalizer(unittest.TestCase):
            def runTest(self):
                class Leaky:
                    def __init__(self):
                        self.cycle = self

                    def __del__(self):
                        warnings.warn("private resource", ResourceWarning)

                item = Leaky()
                del item

        report = GATE_MODULE.run_suite(unittest.TestSuite([Finalizer()]))
        self.assertGreater(report["uncaughtErrors"], 0)
        self.assertFalse(report["success"])
        self.assertNotIn("private resource", json.dumps(report))

    def test_linux_partial_skip_is_not_proof(self):
        class Smoke(unittest.TestCase):
            def runTest(self):
                pass

        class Ignored(unittest.TestCase):
            @unittest.skip("not exercised")
            def runTest(self):
                pass

        Smoke.__module__ = Ignored.__module__ = "test_bootstrap_linux"
        report = GATE_MODULE.run_suite(unittest.TestSuite([Smoke(), Ignored()]), platform_name="linux")
        self.assertEqual(report["linuxSmoke"], {"status": "failed", "tests": 1, "skips": 1})
        self.assertFalse(GATE_MODULE.accept_report(report, require_linux=True))

    def test_empty_suite_does_not_pass(self):
        report = GATE_MODULE.run_suite(unittest.TestSuite())
        self.assertEqual(report["tests"], 0)
        self.assertFalse(report["success"])

    def test_thread_exception_fails_even_when_unittest_passes(self):
        class ThreadFailure(unittest.TestCase):
            def runTest(self):
                worker = threading.Thread(target=lambda: 1 / 0)
                worker.start()
                worker.join()

        report = GATE_MODULE.run_suite(unittest.TestSuite([ThreadFailure()]))
        self.assertEqual(report["failures"], 0)
        self.assertEqual(report["errors"], 0)
        self.assertEqual(report["threadErrors"], 1)
        self.assertFalse(report["success"])

    def test_unraisable_exception_fails_even_when_unittest_passes(self):
        class Unraisable(unittest.TestCase):
            def runTest(self):
                class Broken:
                    def __del__(self):
                        raise RuntimeError("synthetic unraisable")

                instance = Broken()
                del instance
                gc.collect()

        report = GATE_MODULE.run_suite(unittest.TestSuite([Unraisable()]))
        self.assertEqual(report["errors"], 0)
        self.assertEqual(report["uncaughtErrors"], 1)
        self.assertFalse(report["success"])

    def test_discovery_import_error_fails_closed_without_printing_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(Path(directory).resolve().is_relative_to(GATE.parents[2]))
            (Path(directory) / "test_broken.py").write_text(
                "raise RuntimeError('synthetic-secret-value')\n", encoding="utf-8"
            )
            report = GATE_MODULE.run_discovered(Path(directory))
        self.assertGreater(report["errors"], 0)
        self.assertFalse(report["success"])
        self.assertNotIn("synthetic-secret-value", json.dumps(report))

    def test_discovery_with_no_tests_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            report = GATE_MODULE.run_discovered(Path(directory))
        self.assertEqual(report["tests"], 0)
        self.assertFalse(report["success"])

    def test_discovery_runs_matching_test_files(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "test_sample.py").write_text(
                "import unittest\nclass Sample(unittest.TestCase):\n"
                "    def test_ok(self): self.assertTrue(True)\n", encoding="utf-8"
            )
            report = GATE_MODULE.run_discovered(Path(directory))
        self.assertEqual(report["tests"], 1)
        self.assertTrue(report["success"])

    @unittest.skipUnless(sys.platform == "win32", "Windows-only refusal")
    def test_require_linux_refuses_before_discovery_on_windows(self):
        child = subprocess.run(
            [sys.executable, str(GATE), "--require-linux"],
            capture_output=True, text=True, check=False, timeout=5,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"},
        )
        self.assertEqual(child.returncode, 1)
        report = json.loads(child.stdout)
        self.assertEqual(report["tests"], 0)
        self.assertEqual(report["linuxSmoke"]["status"], "not-run")
        self.assertIn("Linux", child.stderr)

    def test_node_wrapper_help_describes_python_and_timeout(self):
        child = subprocess.run(
            ["node", str(WRAPPER), "--help"], capture_output=True,
            text=True, check=False, timeout=5,
        )
        self.assertEqual(child.returncode, 0)
        self.assertIn("PYTHON", child.stdout)
        self.assertIn("100", child.stdout)

    def test_lingering_thread_is_reported_and_stopped_by_fixture(self):
        release = threading.Event()
        worker = None

        class Leaking(unittest.TestCase):
            def runTest(self):
                nonlocal worker
                worker = threading.Thread(target=release.wait, daemon=True)
                worker.start()

        try:
            report = GATE_MODULE.run_suite(unittest.TestSuite([Leaking()]))
            self.assertEqual(report["lingeringThreads"], 1)
            self.assertFalse(report["success"])
        finally:
            release.set()
            if worker:
                worker.join(timeout=2)

    def test_skipped_test_is_counted_without_failing_another_passing_test(self):
        class Skipped(unittest.TestCase):
            @unittest.skip("synthetic")
            def runTest(self):
                self.fail("must not run")

        class Passing(unittest.TestCase):
            def runTest(self):
                self.assertTrue(True)

        report = GATE_MODULE.run_suite(unittest.TestSuite([Skipped(), Passing()]))
        self.assertEqual((report["tests"], report["skips"]), (2, 1))
        self.assertTrue(report["success"])

    @unittest.skipUnless(sys.platform == "win32", "Windows-only refusal")
    def test_node_wrapper_refuses_linux_smoke_without_starting_python(self):
        child = subprocess.run(
            ["node", str(WRAPPER), "--require-linux"], capture_output=True,
            text=True, check=False, timeout=5,
            env={**os.environ, "PYTHON": "missing-python-sentinel"},
        )
        self.assertEqual(child.returncode, 1)
        self.assertIn("Linux", child.stderr)
        self.assertNotIn("missing-python-sentinel", child.stderr)


if __name__ == "__main__":
    unittest.main()
