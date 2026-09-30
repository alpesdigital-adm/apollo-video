"""Linux pipe/process smoke only; no cloud, Docker, database or VM is contacted."""
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest

TOOLS = Path(__file__).resolve().parents[2] / 'scripts' / 'ops' / 'digitalocean-bootstrap'


@unittest.skipUnless(sys.platform == 'linux', 'Linux-only real pipe/process smoke; Windows is not Linux evidence')
class LinuxBootstrapSmoke(unittest.TestCase):
    def read_line(self, proc, timeout=5):
        deadline = time.monotonic() + timeout
        pending = self.buffers.get(proc.pid, b'')
        while b'\n' not in pending:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([proc.stdout], [], [], left)[0]:
                raise AssertionError('child stdout deadline exceeded')
            chunk = os.read(proc.stdout.fileno(), 4096)
            if not chunk: raise AssertionError('child stdout closed before expected line')
            pending += chunk
        line, pending = pending.split(b'\n', 1)
        self.buffers[proc.pid] = pending
        return line.decode().strip()

    def remaining_lines(self, proc):
        return (self.buffers.pop(proc.pid, b'') + os.read(proc.stdout.fileno(), 65536)).decode().splitlines()

    def child(self, body):
        code = ("import sys,signal,time,tempfile\n"
                f"sys.path.insert(0, {str(TOOLS)!r})\n"
                "from pathlib import Path\nimport remote_guard as g\n"
                "with tempfile.TemporaryDirectory() as td:\n"
                "  m=g.Monitor(Path(td), 'pipe-smoke')\n"
                "  m.start_stdin_observer(stream=sys.stdin)\n" + body)
        proc = subprocess.Popen([sys.executable, '-W', 'error::ResourceWarning', '-c', code],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True)
        self.buffers = getattr(self, 'buffers', {})
        return proc

    def finish_child(self, proc):
        try:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try: proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=3)
        finally:
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe and not pipe.closed: pipe.close()
        self.assertIsNotNone(proc.poll(), 'child PID must be terminal')

    def test_open_stdin_then_eof_latches_and_joins(self):
        proc = self.child("  print('READY',flush=True)\n"
                          "  m.check(); print('OPEN',flush=True)\n"
                          "  try:\n"
                          "    while True: m.check(); time.sleep(.01)\n"
                          "  except g.GateClosed as exc:\n"
                          "    print('EOF' if 'EOF' in str(exc) else 'WRONG',flush=True)\n"
                          "  finally:\n"
                          "    m.finish(); print('JOINED' if not m.stdin_thread.is_alive() else 'ALIVE',flush=True)\n")
        try:
            self.assertEqual(self.read_line(proc), 'READY')
            self.assertEqual(self.read_line(proc), 'OPEN')
            self.assertIsNone(proc.poll())
            proc.stdin.close()
            self.assertEqual(proc.wait(timeout=5), 0)
            self.assertEqual(self.remaining_lines(proc), ['EOF', 'JOINED'])
            self.assertEqual(proc.stderr.read(), b'')
        finally:
            self.finish_child(proc)

    def test_signal_interrupts_and_joins_observer(self):
        proc = self.child("  def interrupted(sig, frame): raise g.GateClosed('signal')\n"
                          "  signal.signal(signal.SIGTERM, interrupted)\n"
                          "  try:\n"
                          "    print('READY',flush=True)\n"
                          "    while True: m.check(); time.sleep(.01)\n"
                          "  except g.GateClosed as exc:\n"
                          "    print(str(exc),flush=True)\n"
                          "  finally:\n"
                          "    m.finish(); print('JOINED' if not m.stdin_thread.is_alive() else 'ALIVE',flush=True)\n")
        try:
            self.assertEqual(self.read_line(proc), 'READY')
            os.kill(proc.pid, signal.SIGTERM)
            self.assertEqual(proc.wait(timeout=5), 0)
            self.assertEqual(self.remaining_lines(proc), ['signal', 'JOINED'])
            self.assertEqual(proc.stderr.read(), b'')
        finally:
            self.finish_child(proc)

    def test_command_deadline_terminates_child(self):
        proc = subprocess.run([sys.executable, '-W', 'error::ResourceWarning', '-c',
                               f"import sys;sys.path.insert(0,{str(TOOLS)!r});import remote_guard as g;"
                               "g.command([sys.executable,'-c','import time;time.sleep(10)'], timeout=.1)"],
                              capture_output=True, text=True, timeout=8)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('command deadline exceeded', proc.stderr)
