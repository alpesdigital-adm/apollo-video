import io
import errno
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'ops' / 'digitalocean-bootstrap'))
import remote_guard as g


class GuardTests(unittest.TestCase):
    class StubStream:
        def fileno(self): return 0

    def cfg(self, root):
        return {'run_id': 'w28-1', 'root': str(root), 'expected_droplet_id': 123,
                'expected_commit': '2c147de6eb96b85fc432b4c2b6c92249f21919dc',
                'source_sha256': 'a' * 64, 'duration_seconds': 10800, 'owner_id': 'owner-1'}

    def test_scope_rejects_alias_traversal_and_noninteger(self):
        with self.assertRaises(ValueError):
            g.validate_config(self.cfg('/opt/apollo-validation/w28-1/../evil'))
        with self.assertRaises(ValueError):
            g.validate_config(dict(self.cfg('/opt/apollo-validation/w28-1'), expected_droplet_id=True))
        with self.assertRaises(ValueError):
            g.validate_config(dict(self.cfg('/opt/apollo-validation/w28-1'), run_id='W28'))
        self.assertEqual(g.validate_config(self.cfg('/opt/apollo-validation/w28-1'))['run_id'], 'w28-1')

    def test_local_check_and_help_work_without_linux_or_network(self):
        script = Path(g.__file__ or '')
        example = script.parent/'config.example.json'
        with self.assertRaises(ValueError):
            g.validate_config(json.loads(example.read_text()))
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td)/'config.json'
            cfg.write_text(json.dumps(self.cfg('/opt/apollo-validation/w28-1')))
            with patch.object(g, 'check_identity', side_effect=AssertionError('network forbidden')), \
                 patch.object(g.sys, 'platform', 'win32'), \
                 patch.object(g.sys, 'argv', [str(script), '--check', str(cfg)]):
                self.assertEqual(g.cli(), 0)
            cfg.write_text(json.dumps({**self.cfg('/opt/apollo-validation/w28-1'), 'run_id': '-bad'}))
            with patch.object(g.sys, 'platform', 'win32'), \
                 patch.object(g.sys, 'argv', [str(script), '--check', str(cfg)]):
                self.assertNotEqual(g.cli(), 0)
            cfg.write_text(json.dumps(self.cfg('/opt/apollo-validation/w28-1')))
            with patch.object(g.sys, 'platform', 'win32'), \
                 patch.object(g.sys, 'argv', [str(script), str(cfg)]):
                self.assertNotEqual(g.cli(), 0)
            with patch.object(g.sys, 'platform', 'win32'), \
                 patch.object(g.sys, 'argv', [str(script), '--help']):
                with self.assertRaises(SystemExit) as result:
                    g.cli()
                self.assertEqual(result.exception.code, 0)
            local = subprocess.run([sys.executable, str(script), '--check', str(cfg)],
                                   capture_output=True, text=True, timeout=10)
            self.assertEqual(local.returncode, 0, local.stderr)
            self.assertEqual(json.loads(local.stdout)['event'], 'config_valid')

    def test_config_requires_owner_and_bounds_application_name_bytes(self):
        cfg = self.cfg('/opt/apollo-validation/w28-1')
        for owner in ('', 'with spaces', 'secret@example.org'):
            with self.assertRaises(ValueError):
                g.validate_config({**cfg, 'owner_id': owner})
        with self.assertRaises(ValueError):
            g.validate_config({k: v for k, v in cfg.items() if k != 'owner_id'})
        name = 'a' * (63 - len('apollo-video-e2e-synthetic-wave24-'))
        self.assertEqual(len(g.pg_application_name(name).encode('utf8')), 63)
        with self.assertRaises(ValueError):
            g.validate_config({**cfg, 'run_id': name + 'a', 'root': '/opt/apollo-validation/' + name + 'a'})
        for run in ('-bad', 'bad-', 'a' * 30):
            with self.subTest(run=run), self.assertRaises(ValueError):
                g.validate_config({**cfg, 'run_id': run, 'root': '/opt/apollo-validation/' + run})
        self.assertEqual(g.validate_config({**cfg, 'owner_id': 'A_b-9'})['owner_id'], 'A_b-9')

    def test_stdin_observer_initialization_and_runtime_failure_are_sticky(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(Path(td), 'w28-1')
            with self.assertRaisesRegex(g.GateClosed, 'stdin observer'):
                m.start_stdin_observer(lambda fd: (_ for _ in ()).throw(OSError('init failed')), stream=self.StubStream())
            with self.assertRaisesRegex(g.GateClosed, 'init failed'):
                m.check()
            m.finish()
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                n = g.Monitor(Path(td), 'w28-1')
            entered = threading.Event()
            def bad_wait(timeout):
                entered.set()
                raise OSError('runtime failed')
            try:
                n.start_stdin_observer(lambda fd: bad_wait, stream=self.StubStream())
            except g.GateClosed:
                pass  # A failure during start must fail admission immediately.
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(g.GateClosed, 'runtime failed'):
                n.check()
            n.finish()
            self.assertFalse(n.stdin_thread.is_alive())

    def test_stdin_observer_open_eof_and_unexpected_death(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(Path(td), 'w28-1')
            eof = threading.Event()
            m.start_stdin_observer(lambda fd: lambda timeout: eof.wait(timeout), stream=self.StubStream())
            m.check()
            self.assertTrue(m.stdin_thread.is_alive())
            eof.set()
            self.assertTrue(m.closed.wait(2))
            with self.assertRaisesRegex(g.GateClosed, 'EOF'):
                m.check()
            m.finish()
            self.assertFalse(m.stdin_thread.is_alive())
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                n = g.Monitor(Path(td), 'w28-1')
            try:
                n.start_stdin_observer(lambda fd: lambda timeout: None, stream=self.StubStream())
            except g.GateClosed:
                pass
            n.stdin_thread.join(2)
            with self.assertRaises(g.GateClosed):
                n.check()
            n.finish()

    def test_verdict_busy_steal_load_mem_oom_invalid(self):
        ok = dict(busy=49, steal=0, load_ratio=.3, available_kib=4 * 1024 * 1024, oom_delta=0)
        self.assertIsNone(g.verdict(ok, 0)[0])
        self.assertEqual(g.verdict({**ok, 'busy': 70}, 0)[0], 'busy')
        self.assertEqual(g.verdict({**ok, 'busy': 50}, 3)[0], 'busy_sustained')
        self.assertEqual(g.verdict({**ok, 'steal': 10}, 0)[0], 'steal')
        self.assertEqual(g.verdict({**ok, 'load_ratio': .75}, 0)[0], 'load')
        self.assertEqual(g.verdict({**ok, 'available_kib': 2097151}, 0)[0], 'memory')
        self.assertEqual(g.verdict({**ok, 'oom_delta': 1}, 0)[0], 'oom')
        self.assertEqual(g.verdict({**ok, 'busy': float('nan')}, 0)[0], 'invalid')

    def test_metadata_exact_and_archive_safety(self):
        with patch.object(g, 'urlopen', side_effect=lambda *a, **kw: io.BytesIO(b'123\n')):
            g.check_identity(123)
            with self.assertRaises(g.GateClosed):
                g.check_identity(124)
        with tempfile.TemporaryDirectory() as td:
            archive = Path(td) / 'a.tar'
            with tarfile.open(archive, 'w') as tar:
                info = tarfile.TarInfo('../outside')
                info.size = 1
                tar.addfile(info, io.BytesIO(b'x'))
            with self.assertRaises(g.GateClosed):
                g.safe_extract(archive, Path(td) / 'source')
            self.assertFalse((Path(td) / 'outside').exists())

    def test_archive_budget_parity_rejects_before_any_extraction(self):
        from prepare_bundle import MAX_ARCHIVE_BYTES, MAX_ARCHIVE_MEMBERS
        self.assertEqual((g.MAX_ARCHIVE_BYTES, g.MAX_ARCHIVE_MEMBERS),
                         (MAX_ARCHIVE_BYTES, MAX_ARCHIVE_MEMBERS))
        with tempfile.TemporaryDirectory() as td, \
             patch.object(g, 'MAX_ARCHIVE_BYTES', 2), \
             patch.object(g, 'MAX_ARCHIVE_MEMBERS', 2):
            root = Path(td)
            for entries, reason in [([('first', b'ab'), ('second', b'c')], 'byte'),
                                    ([('first', b'a'), ('second', b'b'), ('third', b'')], 'member')]:
                archive = root/'source.tar'; dest = root/'source'
                with tarfile.open(archive, 'w') as tar:
                    for name, data in entries:
                        info = tarfile.TarInfo(name); info.size = len(data)
                        tar.addfile(info, io.BytesIO(data))
                with self.assertRaisesRegex(g.GateClosed, reason):
                    g.safe_extract(archive, dest)
                self.assertFalse((dest/'first').exists())
            with tarfile.open(archive, 'w') as tar:
                tar.addfile(tarfile.TarInfo('empty'))
            with patch.object(g, 'MAX_ARCHIVE_MEMBERS', 5), patch.object(g, 'MAX_ARCHIVE_BYTES', 0):
                with self.assertRaisesRegex(g.GateClosed, 'physical'):
                    g.safe_extract(archive, dest)
                self.assertFalse(dest.exists())

    def test_timeout_and_redaction(self):
        self.assertEqual(g.redact('postgresql://apollo:secret@127.0.0.1/db POSTGRES_PASSWORD=abc',
                                  ['secret', 'abc']), 'postgresql://apollo:[REDACTED]@127.0.0.1/db POSTGRES_PASSWORD=[REDACTED]')
        with self.assertRaises(g.GateClosed):
            with tempfile.TemporaryDirectory() as td:
                g.command(['python', '-c', 'import time; time.sleep(10)'], timeout=0.1,
                          log=Path(td) / 'command.log')

    def test_container_identity_failure_blocks_stop(self):
        with patch.object(g, 'command', return_value='other|true|123'):
            with self.assertRaises(g.GateClosed):
                g.container_identity('w28-1-runner', 'w28-1')

    def test_owner_lock_excludes_second_owner_without_overwriting(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'owner.lock'
            original_fstat = os.fstat
            def root_stat(fd):
                info = original_fstat(fd)
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0,
                                       st_dev=info.st_dev, st_ino=info.st_ino, st_size=info.st_size)
            with patch.object(g.os, 'fstat', side_effect=root_stat):
                with g.owner_lock('first', 300, path) as record:
                    self.assertEqual(record['runId'], 'first')
                    self.assertTrue(record['deadlineUTC'].endswith('Z'))
                    with self.assertRaises(g.GateClosed):
                        with g.owner_lock('second', 300, path):
                            pass
                    # Windows byte-range locks also prohibit Path.read_text while held.
                    self.assertEqual(record['pid'], os.getpid())
            self.assertEqual(path.read_text(), '')

    def test_owner_lock_stat_contract_with_controlled_linux_metadata(self):
        good = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
        g.validate_owner_lock_stat(good)
        for mode, uid in ((stat.S_IFREG | 0o640, 0), (stat.S_IFREG | 0o602, 0),
                          (stat.S_IFREG | 0o600, 1001), (stat.S_IFDIR | 0o600, 0),
                          (stat.S_IFIFO | 0o600, 0), (stat.S_IFLNK | 0o600, 0)):
            with self.subTest(mode=mode, uid=uid), self.assertRaises(g.GateClosed):
                g.validate_owner_lock_stat(SimpleNamespace(st_mode=mode, st_uid=uid))

    def test_owner_lock_rejects_preexisting_invalid_stat_before_mutation_and_closes_fd(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'owner.lock'; path.write_bytes(b'KEEP-FOREIGN')
            real_fstat, real_close, real_open = os.fstat, os.close, os.open
            nofollow = getattr(os, 'O_NOFOLLOW', 0x2000000)
            def guarded_open(p, flags, mode=0o777):
                # Windows does not define O_NOFOLLOW. Strip only its controlled
                # fake bit after verifying the Linux path requests it.
                self.assertTrue(flags & nofollow)
                return real_open(p, flags & ~nofollow if os.name == 'nt' else flags, mode)
            for mode, uid in ((stat.S_IFREG | 0o600, 1001), (stat.S_IFREG | 0o644, 0),
                              (stat.S_IFDIR | 0o600, 0)):
                closed = []
                def fake_stat(fd):
                    info = real_fstat(fd)
                    return SimpleNamespace(st_mode=mode, st_uid=uid, st_dev=info.st_dev,
                                           st_ino=info.st_ino, st_size=info.st_size)
                with self.subTest(mode=mode, uid=uid), \
                     patch.object(g.sys, 'platform', 'linux'), \
                     patch.object(g.os, 'O_NOFOLLOW', nofollow, create=True), \
                     patch.object(g.os, 'open', side_effect=guarded_open), \
                     patch.object(g.os, 'fstat', side_effect=fake_stat), \
                     patch.object(g.os, 'close', side_effect=lambda fd: (closed.append(fd), real_close(fd))), \
                     patch.object(g.os, 'read', side_effect=AssertionError('read before stat')), \
                     patch.object(g.os, 'write', side_effect=AssertionError('write before stat')), \
                     patch.object(g.os, 'ftruncate', side_effect=AssertionError('truncate before stat')):
                    with self.assertRaises(g.GateClosed):
                        with g.owner_lock('run', 300, path): pass
                self.assertEqual(len(closed), 1)
                self.assertEqual(path.read_bytes(), b'KEEP-FOREIGN')

    def test_owner_lock_symlink_is_not_followed_or_repaired(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); path = root/'owner.lock'; target = root/'target'
            target.write_bytes(b'KEEP-TARGET')
            try:
                path.symlink_to(target)
            except OSError:
                # Windows installations without symlink privilege: emulate ELOOP
                # from a no-follow open, while still asserting the requested flags.
                pass
            real_open = os.open
            nofollow = getattr(os, 'O_NOFOLLOW', 0x2000000)
            def open_link(p, flags, mode=0o777):
                if Path(p) == path and flags & nofollow:
                    raise OSError(errno.ELOOP, 'symlink refused')
                return real_open(p, flags, mode)
            with patch.object(g.os, 'O_NOFOLLOW', nofollow, create=True), \
                 patch.object(g.os, 'open', side_effect=open_link) as opened:
                with self.assertRaises((g.GateClosed, OSError)):
                    with g.owner_lock('run', 300, path): pass
            self.assertTrue(any(call.args[1] & nofollow for call in opened.call_args_list))
            self.assertEqual(target.read_bytes(), b'KEEP-TARGET')
            if path.is_symlink(): self.assertTrue(path.is_symlink())

    def test_owner_lock_linux_requires_nofollow_before_open(self):
        with patch.object(g.sys, 'platform', 'linux'), \
             patch.object(g.os, 'O_NOFOLLOW', 0, create=True), \
             patch.object(g.os, 'open', side_effect=AssertionError('must not open')) as opened:
            with self.assertRaisesRegex(g.GateClosed, 'O_NOFOLLOW'):
                with g.owner_lock('run', 300, Path('never-opened')): pass
            opened.assert_not_called()

    def test_owner_lock_open_errno_and_fstat_error_close_without_mutation(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'owner.lock'; path.write_bytes(b'KEEP')
            real_close = os.close
            with patch.object(g.os, 'open', side_effect=OSError(errno.EACCES, 'denied')):
                with self.assertRaises(OSError) as caught:
                    with g.owner_lock('run', 300, path): pass
            self.assertEqual(caught.exception.errno, errno.EACCES)
            closed = []
            with patch.object(g.os, 'fstat', side_effect=OSError(errno.EIO, 'stat failed')), \
                 patch.object(g.os, 'close', side_effect=lambda fd: (closed.append(fd), real_close(fd))):
                with self.assertRaises(OSError) as caught:
                    with g.owner_lock('run', 300, path): pass
            self.assertEqual(caught.exception.errno, errno.EIO)
            self.assertEqual(len(closed), 1)
            self.assertEqual(path.read_bytes(), b'KEEP')

    def test_owner_lock_stale_record_is_never_truncated(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'owner.lock'; path.write_bytes(b'{"runId":"old"}')
            real_fstat = os.fstat
            def root_stat(fd):
                info = real_fstat(fd)
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0,
                                       st_dev=info.st_dev, st_ino=info.st_ino, st_size=info.st_size)
            with patch.object(g.os, 'fstat', side_effect=root_stat):
                with self.assertRaisesRegex(g.GateClosed, 'stale owner record'):
                    with g.owner_lock('new', 300, path): pass
            self.assertEqual(path.read_bytes(), b'{"runId":"old"}')

    def test_owner_lock_replacement_is_not_cleared(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'owner.lock'; displaced = Path(td)/'displaced'
            real_fstat = os.fstat
            def root_stat(fd):
                info = real_fstat(fd)
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0,
                                       st_dev=info.st_dev, st_ino=info.st_ino, st_size=info.st_size)
            with patch.object(g.os, 'fstat', side_effect=root_stat):
                if os.name == 'nt':
                    # Windows cannot rename an open locked file. Simulate pathname
                    # replacement only at lstat; retain the original record intact.
                    real_lstat = os.lstat
                    replaced = [False]
                    def named(p):
                        info = real_lstat(p)
                        if replaced[0] and Path(p) == path:
                            return SimpleNamespace(st_mode=info.st_mode, st_dev=info.st_dev,
                                                   st_ino=info.st_ino + 1)
                        return info
                    with patch.object(g.os, 'lstat', side_effect=named):
                        with self.assertRaisesRegex(g.GateClosed, 'replaced|changed'):
                            with g.owner_lock('run', 300, path): replaced[0] = True
                    self.assertIn(b'"runId": "run"', path.read_bytes())
                else:
                    with self.assertRaisesRegex(g.GateClosed, 'replaced|changed'):
                        with g.owner_lock('run', 300, path):
                            path.rename(displaced)
                            path.write_bytes(b'REPLACEMENT')
                    self.assertEqual(path.read_bytes(), b'REPLACEMENT')
                    self.assertIn(b'"runId": "run"', displaced.read_bytes())

    def test_command_timeout_closes_pipe_with_resource_warnings_as_errors(self):
        with self.assertRaises(g.GateClosed):
            g.command([sys.executable, '-c', 'import time; time.sleep(10)'], timeout=.05)

    def test_command_joins_delayed_reader_before_return_or_error(self):
        entered = threading.Event()
        original = g.redact
        def delayed(text, values=()):
            entered.set()
            time.sleep(.4)  # longer than the command poll interval
            return original(text, values)
        with patch.object(g, 'redact', side_effect=delayed):
            self.assertEqual(g.command([sys.executable, '-c', 'print("complete")'], timeout=3), 'complete')
            self.assertTrue(entered.is_set())
            with self.assertRaisesRegex(g.GateClosed, 'error-line'):
                g.command([sys.executable, '-c', 'print("error-line"); exit(7)'], timeout=3)

    def test_missing_docker_before_create_does_not_prevent_postflight(self):
        with tempfile.TemporaryDirectory() as td:
            r = g.Run(self.cfg('/opt/apollo-w28-w28-1'))
            r.root = Path(td)
            with patch.object(g, 'container_identity', side_effect=FileNotFoundError('docker absent')):
                self.assertEqual(r.cleanup(), [])
            self.assertEqual(r.orphans, 'N/A')
            self.assertTrue(r.cleanup_ok)

    def test_ambiguous_create_never_claims_zero_orphans(self):
        with tempfile.TemporaryDirectory() as td:
            r = g.Run(self.cfg('/opt/apollo-w28-w28-1'))
            r.root = Path(td)
            r.create_attempted.add(r.pg)
            with patch.object(g, 'container_identity', side_effect=FileNotFoundError('docker absent')):
                self.assertTrue(r.cleanup())
            self.assertEqual(r.orphans, 'N/A')

    def test_pg_tcp_password_env_not_argv_and_private_file(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'pg.env'
            original = os.open
            with patch.object(g.os, 'open', side_effect=lambda p, flags, mode=0o777: original(p, flags, mode)) as op:
                g.write_pg_env(path, 'random-credential')
            self.assertIn('PGPASSWORD=random-credential\n', path.read_text())
            self.assertIn('POSTGRES_PASSWORD=random-credential\n', path.read_text())
            self.assertEqual(op.call_args.args[2], 0o600)
            if os.name != 'nt': self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_docker_and_containerd_quota_content(self):
        self.assertEqual(g.service_budget(), '[Service]\nSlice=apollo-validation.slice\nCPUQuota=25%\n')

    def test_git_prerequisite_fails_before_any_host_configuration(self):
        r = g.Run(self.cfg('/opt/apollo-validation/w28-1'))
        with patch.object(r, 'step', side_effect=g.GateClosed('git unavailable')) as step, \
             patch.object(r, 'files', side_effect=AssertionError('host writes forbidden')):
            with self.assertRaisesRegex(g.GateClosed, 'git unavailable'):
                r.prepare()
        self.assertEqual(step.call_args.args[:2], ('git_version', ['git', '--version']))

    def test_next_start_clock_begins_at_process_not_build(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root/'evidence').mkdir()
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(root, 'w28-1')
            m.runner = 'w28-1-runner'
            host = dict(busy=1, steal=0, iowait=0, load1=0, ncpu=8,
                        load_ratio=0, available_kib=4*1024**2, oom_total=0)
            with patch.object(g, 'host_read', side_effect=lambda previous: (m.prev, host.copy())), \
                 patch.object(g, 'container_identity', return_value=(True, 100)), \
                 patch.object(m, 'find_next', side_effect=[(False, None), (True, None), (True, None)]), \
                 patch.object(g.time, 'monotonic', side_effect=[500, 500, 500, 500, 681, 681]):
                m.sample('build')
                self.assertIsNone(m.next_started)
                m.sample('journey')
                self.assertTrue(m.next_seen)
                with self.assertRaisesRegex(g.GateClosed, 'next_startup'):
                    m.sample('journey')

    def test_journey_must_observe_next_even_if_runner_succeeded(self):
        with tempfile.TemporaryDirectory() as td:
            r = g.Run(self.cfg('/opt/apollo-w28-w28-1'))
            r.root = Path(td)
            (r.root/'evidence').mkdir()
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                r.monitor = g.Monitor(r.root, r.run)
            with self.assertRaisesRegex(g.GateClosed, 'never observed'):
                r.verify_journey()

    def test_eof_latches_work_but_postflight_samples_continue(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root/'evidence').mkdir()
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(root, 'w28-1')
            m.closed.set()
            with self.assertRaisesRegex(g.GateClosed, 'EOF'):
                m.check()
            host = dict(busy=1, steal=0, iowait=0, load1=0, ncpu=8,
                        load_ratio=0, available_kib=4*1024**2, oom_total=0)
            with patch.object(g, 'host_read', side_effect=lambda previous: (m.prev, host.copy())):
                m.sample('postflight')
            self.assertEqual(m.samples, 1)
            self.assertEqual(json.loads((root/'evidence'/'samples.jsonl').read_text())['stage'], 'postflight')

    def test_preflight_failure_still_collects_six_postflight_samples(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); (root/'evidence').mkdir()
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(root, 'w28-1')
            m.closed.set(); m.failure = 'monitor: memory'
            clock = [0]
            host = dict(busy=1, steal=0, iowait=0, load1=0, ncpu=8,
                        load_ratio=0, available_kib=4*1024**2, oom_total=0)
            with patch.object(g.time, 'monotonic', side_effect=lambda: clock[0]), \
                 patch.object(g.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)), \
                 patch.object(g, 'host_read', side_effect=lambda previous: (m.prev, host.copy())):
                m.window('postflight')
            self.assertEqual(m.samples, 6)
            self.assertEqual(clock[0], 60)
            self.assertEqual(m.failure, 'monitor: memory')
            self.assertEqual(m.windows['postflight'], {'started': 0, 'finished': 60})
            stamps = [json.loads(line)['monotonic_at'] for line in (root/'evidence'/'samples.jsonl').read_text().splitlines()]
            self.assertEqual(stamps, [10, 20, 30, 40, 50, 60])
            with self.assertRaisesRegex(g.GateClosed, 'EOF'):
                m.check()

    def test_six_partial_ticks_do_not_complete_threaded_window(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(Path(td), 'w28-1')
            class Alive:
                def is_alive(self): return True
            m.thread = Alive()
            clock = [0]
            def wait(seconds):
                clock[0] += seconds
                if clock[0] >= 5: m.samples = 6
                return False
            with patch.object(g.time, 'monotonic', side_effect=lambda: clock[0]), \
                 patch.object(m.stop, 'wait', side_effect=wait):
                m.window('postflight')
            self.assertGreaterEqual(clock[0], 60)
            self.assertEqual(m.windows['postflight']['finished'], clock[0])

    def test_postflight_record_contains_owner_and_cannot_turn_failure_green(self):
        with tempfile.TemporaryDirectory() as td:
            r = g.Run(self.cfg('/opt/apollo-w28-w28-1')); r.root = Path(td)/'run'
            r.owner_record = {'pid': 111, 'deadlineUTC': '2026-09-30T00:00:00Z'}
            class FakeMonitor:
                failure = 'monitor: gate failed'
                samples = 12
                windows = {}
                closed = threading.Event()
                def window(self, stage):
                    if stage == 'preflight': self.check()
                    self.samples += 6
                def start(self): pass
                def check(self): raise g.GateClosed(self.failure)
                def finish(self): pass
            with patch.object(g, 'check_identity'), patch.object(g, 'check_host_capacity'), patch.object(g, 'Monitor', return_value=FakeMonitor()), \
                 patch.object(r, 'cleanup', return_value=[]), patch.object(g.signal, 'signal'), \
                 patch.object(g.signal, 'SIGHUP', 1, create=True):
                r.cleanup_ok = True
                self.assertEqual(r._main_locked(), 1)
            result = json.loads((r.root/'evidence'/'postflight.json').read_text())
            self.assertEqual(result['run_id'], 'w28-1')
            self.assertEqual(result['owner_pid'], 111)
            self.assertEqual(result['owner_deadline_utc'], '2026-09-30T00:00:00Z')
            self.assertEqual(result['samples'], 18)
            self.assertEqual(result['windows'], {})
            self.assertFalse(result['cleanup_ok'])
            self.assertEqual(result['owner_id'], 'owner-1')
            self.assertEqual(result['expected_droplet_id'], 123)
            self.assertEqual(result['source_commit'], self.cfg('/opt/apollo-validation/w28-1')['expected_commit'])
            self.assertEqual(result['orphan_backends'], 'N/A')
            self.assertEqual(result['container_states']['pg'], 'never_started')
            self.assertTrue(result['errors'])

    def test_existing_root_and_identity_failure_never_mutate_foreign_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)/'run'; evidence = root/'evidence'
            evidence.mkdir(parents=True)
            sentinel = evidence/'postflight.json'; sentinel.write_text('KEEP-ME')
            for identity_error in (None, g.GateClosed('identity mismatch')):
                r = g.Run(self.cfg(root))
                with patch.object(g, 'check_identity', side_effect=identity_error), \
                     patch.object(g, 'check_host_capacity'), patch.object(r, 'cleanup', side_effect=AssertionError('foreign cleanup')), \
                     patch.object(g.signal, 'signal'), patch.object(g.signal, 'SIGHUP', 1, create=True):
                    self.assertEqual(r._main_locked(), 1)
                self.assertEqual(sentinel.read_text(), 'KEEP-ME')
                self.assertFalse(r.owns_root)
                self.assertEqual(r.postflight_result(1, 'original failure', [])['error'], 'original failure')
            missing = Path(td)/'missing'
            r = g.Run(self.cfg(missing))
            with patch.object(g, 'check_identity', side_effect=g.GateClosed('identity mismatch')), \
                 patch.object(g.signal, 'signal'), patch.object(g.signal, 'SIGHUP', 1, create=True):
                self.assertEqual(r._main_locked(), 1)
            self.assertFalse(missing.exists())

    def test_partial_owned_root_records_original_failure_without_monitor(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)/'run'; r = g.Run(self.cfg(root))
            mkdir = Path.mkdir
            def fail_logs(path, *args, **kwargs):
                if path == root/'logs': raise OSError('original logs failure')
                return mkdir(path, *args, **kwargs)
            with patch.object(g, 'check_identity'), patch.object(g, 'check_host_capacity'), \
                 patch.object(Path, 'mkdir', autospec=True, side_effect=fail_logs), \
                 patch.object(g.signal, 'signal'), patch.object(g.signal, 'SIGHUP', 1, create=True):
                self.assertEqual(r._main_locked(), 1)
            result = json.loads((root/'evidence'/'postflight.json').read_text())
            self.assertIn('original logs failure', result['error'])
            self.assertEqual(result['windows'], {})
            self.assertTrue(r.owns_root)

    def test_failed_postflight_does_not_publish_window(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(Path(td), 'w28-1')
            clock = [0]
            with patch.object(g.time, 'monotonic', side_effect=lambda: clock[0]), \
                 patch.object(g.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)), \
                 patch.object(g, 'host_read', side_effect=OSError('metrics unavailable')):
                with self.assertRaisesRegex(g.GateClosed, 'metrics unavailable'):
                    m.window('postflight')
            self.assertNotIn('postflight', m.windows)

    def test_pg_readiness_retries_only_typed_transient_with_reserve(self):
        r = g.Run(self.cfg('/opt/apollo-validation/w28-1'))
        class Healthy:
            def check(self): pass
        r.monitor = Healthy()
        r.deadline = 280; r.reserve = 180
        clock = [0]
        with patch.object(g.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(g.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)):
            with patch.object(r, 'step', side_effect=g.GateClosed('total deadline/cleanup reserve')) as step:
                with self.assertRaisesRegex(g.GateClosed, 'total deadline/cleanup reserve'):
                    r.wait_pg_ready()
                self.assertEqual(step.call_count, 1)
            with patch.object(r, 'step', side_effect=['PG_READY_STATUS:2', 'PG_READY_STATUS:1', 'PG_READY_STATUS:0']) as step:
                r.wait_pg_ready()
                self.assertEqual(step.call_count, 3)
                self.assertIn('pg_isready', step.call_args.args[1][-1])
            clock[0] = 0
            def spent_deadline(*args, **kwargs):
                clock[0] = 101
                return 'PG_READY_STATUS:0'
            with patch.object(r, 'step', side_effect=spent_deadline) as step:
                with self.assertRaisesRegex(g.GateClosed, 'total deadline/cleanup reserve'):
                    r.wait_pg_ready()
                self.assertEqual(step.call_count, 1)
            clock[0] = 99
            with patch.object(r, 'step', return_value='PG_READY_STATUS:2') as step:
                with self.assertRaisesRegex(g.GateClosed, 'total deadline/cleanup reserve'):
                    r.wait_pg_ready()
                self.assertEqual(step.call_count, 1)
            clock[0] = 0
            with patch.object(r, 'step', return_value='PG_READY_STATUS:3') as step:
                with self.assertRaisesRegex(g.GateClosed, 'PG readiness probe failed'):
                    r.wait_pg_ready()
                self.assertEqual(step.call_count, 1)

    def test_no_create_is_na_not_verified_pg_zero(self):
        with tempfile.TemporaryDirectory() as td:
            r = g.Run(self.cfg('/opt/apollo-w28-w28-1')); r.root = Path(td)
            self.assertEqual(r.cleanup(), [])
            self.assertEqual(r.orphans, 'N/A')

    def test_next_renamed_process_socket_inodes_and_pid_scope(self):
        with tempfile.TemporaryDirectory() as td:
            proc = Path(td)
            for pid, inode in ((101, '42'), (102, '44'), (999, '43')):
                (proc / str(pid) / 'fd').mkdir(parents=True)
                (proc / str(pid) / 'fd' / '3').write_text(inode)
            (proc / 'net').mkdir()
            head = '  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode\n'
            def row(ip, port, inode, state='0A'):
                return f'   0: {ip}:{port} {ip}:0000 {state} 00000000:00000000 00:00000000 00000000 1000 0 {inode} 1 0000000000000000 100 0 0 10 0\n'
            ip4 = '00000000'; ip6 = '00000000000000000000000000000000'
            (proc / 'net' / 'tcp').write_text(head + row(ip4, '0D05', 42) + row(ip4, '22B8', 43) + row(ip4, '22B9', 42, '01'))
            (proc / 'net' / 'tcp6').write_text(head + row(ip6, '0D05', 44))
            top = 'PID                 COMMAND\n101 next-server (v16.3.4)\n102 node node_modules/next/dist/bin/next start -p 3333\n999 next-server (v16.3.4)'
            def link(path):
                return 'socket:['+Path(path).read_text()+']'
            with patch.object(g, 'command', return_value=top.replace('999 next-server (v16.3.4)', '999 other')), patch.object(g.os, 'readlink', side_effect=link):
                self.assertEqual(g.Monitor.find_next('owned-runner', proc=proc), (True, 3333))
            with patch.object(g, 'command', return_value='PID COMMAND\n999 other'), patch.object(g.os, 'readlink', side_effect=link):
                self.assertEqual(g.Monitor.find_next('owned-runner', proc=proc), (False, None))
            (proc / 'net' / 'tcp').write_text(head + row(ip4, '0D05', 42, '01') + row(ip4, '22B8', 43))
            (proc / 'net' / 'tcp6').write_text(head + row(ip6, '0D05', 44, '01'))
            with patch.object(g, 'command', return_value=top.replace('999 next-server (v16.3.4)', '999 other')), patch.object(g.os, 'readlink', side_effect=link):
                self.assertEqual(g.Monitor.find_next('owned-runner', proc=proc), (True, None))
            (proc / 'net' / 'tcp').write_text(head + row(ip4, '0D05', 42) + row(ip4, '22B8', 43))
            (proc / 'net' / 'tcp6').write_text(head + row(ip6, '0D05', 44))
            (proc / '101' / 'fd' / '4').write_text('43')
            with patch.object(g, 'command', return_value=top), patch.object(g.os, 'readlink', side_effect=link):
                with self.assertRaisesRegex(g.GateClosed, 'multiple Next ports'):
                    g.Monitor.find_next('owned-runner', proc=proc)

    def test_oom_since_boot_blocks_first_sample(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(g, 'counters', return_value=(100, 10, 0, 0)):
                m = g.Monitor(Path(td), 'w28-1')
            (Path(td) / 'evidence').mkdir()
            host = dict(busy=1, steal=0, iowait=0, load1=0, ncpu=8,
                        load_ratio=0, available_kib=4 * 1024**2, oom_total=1)
            with patch.object(g, 'host_read', return_value=(m.prev, host)):
                with self.assertRaisesRegex(g.GateClosed, 'oom'):
                    m.sample('preflight')

    def test_other_e2e_application_is_not_ours(self):
        self.assertEqual(g.pg_activity_sql('w28-1').count("application_name='apollo-video-e2e-synthetic-wave24-w28-1'"), 1)
        self.assertNotIn('like', g.pg_activity_sql('w28-1').lower())

    def test_guard_thresholds_match_canonical_policy(self):
        policy = json.loads((Path(__file__).resolve().parents[2] / 'config' / 'host-safety-policy.json').read_text())
        t, w = policy['thresholds'], policy['windows']
        ok = dict(busy=0, steal=0, load_ratio=0, available_kib=t['memoryAvailableMinimumBytes']//1024, oom_delta=0)
        self.assertEqual(g.verdict({**ok, 'busy': t['cpuBusyPeakRatio']*100}, 0)[0], 'busy')
        self.assertEqual(g.verdict({**ok, 'steal': t['stealRatio']*100}, 0)[0], 'steal')
        self.assertEqual(g.verdict({**ok, 'load_ratio': t['loadPerCpuRatio']}, 0)[0], 'load')
        self.assertEqual(g.verdict({**ok, 'available_kib': ok['available_kib']-1}, 0)[0], 'memory')
        self.assertEqual(g.verdict({**ok, 'busy': t['cpuBusySustainedRatio']*100}, 2)[0], None)
        self.assertEqual(g.verdict({**ok, 'busy': t['cpuBusySustainedRatio']*100}, 3)[0], 'busy_sustained')
        self.assertEqual((w['preflightMs'], w['postflightMs']), (60000, 60000))

    def test_capacity_uses_linux_usable_memory_allowance_not_nominal_plan(self):
        with self.assertRaises(g.GateClosed): g.validate_host_capacity(7, 16*1024*1024)
        with self.assertRaises(g.GateClosed): g.validate_host_capacity(8, int(14.9*1024*1024))
        g.validate_host_capacity(8, int(15.6*1024*1024))

    def test_batch_requires_writable_mounted_dirs_and_records_smoke_log(self):
        script = Path(__file__).resolve().parents[2] / 'scripts' / 'ops' / 'digitalocean-bootstrap' / 'batch.sh'
        text = script.read_text()
        self.assertIn('"/opt/apollo-validation/$RUN"', text)
        # Exercise the actual directory preflight and phase function, isolating only
        # the production /opt argument gate because a Windows temp root is used.
        head = 'set -Eeuo pipefail\nROOT=$1\nRUN=$2\nSRC="$ROOT/source"' + text.split('SRC="$ROOT/source"', 1)[1].split('node --version >')[0]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            shell_root = '/' + root.drive[0].lower() + root.as_posix()[2:] if root.drive else str(root)
            bash = shutil.which('bash')
            if os.name == 'nt':
                bash = 'C:/Program Files/Git/usr/bin/bash.exe'
            for part in ('source', 'state', 'evidence', 'logs'):
                (root/part).mkdir()
            result = subprocess.run([bash, '-c', head + '\nphase smoke 3 bash -c "printf smoke-output"', 'batch', shell_root, 'w28-1'],
                                    capture_output=True, text=True, errors='replace', timeout=8)
            self.assertEqual(result.returncode, 0, (result.stdout, result.stderr))
            self.assertEqual((root/'logs'/'smoke.log').read_text(), 'smoke-output')
            self.assertEqual(json.loads((root/'evidence'/'batch-results.jsonl').read_text())['phase'], 'smoke')
            (root/'logs'/'smoke.log').unlink()
            (root/'logs').rmdir()
            blocked = subprocess.run([bash, '-c', head + '\nphase smoke 3 true', 'batch', shell_root, 'w28-1'],
                                     capture_output=True, text=True, errors='replace', timeout=8)
            self.assertNotEqual(blocked.returncode, 0)

    def test_runner_arguments_mount_only_owned_paths_and_logs(self):
        root = '/opt/apollo-validation/demo'
        tools = Path('/opt/apollo-validation/tools')
        argv = g.runner_arguments(root, 'demo', Path(root)/'state'/'runner.env', tools)
        mounts = [argv[i+1] for i, arg in enumerate(argv[:-1]) if arg == '-v']
        self.assertEqual(mounts, [root+'/source:'+root+'/source', root+'/state:'+root+'/state',
                                  root+'/evidence:'+root+'/evidence', root+'/logs:'+root+'/logs',
                                  str(tools)+':'+str(tools)+':ro'])
        self.assertEqual(argv[-4:], ['bash', str(tools/'batch.sh'), root, 'demo'])
        self.assertNotIn('apollo-w28-RUN', ' '.join(argv))

    def test_host_rejects_missing_batch_log_without_claiming_journey(self):
        with tempfile.TemporaryDirectory() as td:
            r = g.Run(self.cfg('/opt/apollo-validation/w28-1'))
            r.root = Path(td)
            (r.root/'evidence').mkdir(exist_ok=True)
            (r.root/'logs').mkdir(exist_ok=True)
            (r.root/'evidence'/'batch-results.jsonl').write_text('{"phase":"smoke","exit_code":0}\n')
            with self.assertRaisesRegex(g.GateClosed, 'batch phase'):
                r.verify_batch_logs()
            (r.root/'logs'/'smoke.log').touch()
            with self.assertRaisesRegex(g.GateClosed, 'batch phase'):
                r.verify_batch_logs()

    def test_batch_requires_every_phase_in_actual_order_and_zero_exit(self):
        with tempfile.TemporaryDirectory() as td:
            r = g.Run(self.cfg('/opt/apollo-validation/w28-1')); r.root = Path(td)
            (r.root/'logs').mkdir(); (r.root/'evidence').mkdir()
            expected = g.batch_phases()
            self.assertEqual(expected[-1], 'synthetic-wave24-journey')
            for phase in expected: (r.root/'logs'/f'{phase}.log').touch()
            results = r.root/'evidence'/'batch-results.jsonl'
            def write(phases):
                results.write_text(''.join(json.dumps({'phase': p, 'exit_code': 0})+'\n' for p in phases))
            write(expected[:-1])
            with self.assertRaises(g.GateClosed): r.verify_batch_logs()
            write(expected + expected[-1:])
            with self.assertRaises(g.GateClosed): r.verify_batch_logs()
            write(expected)
            r.verify_batch_logs()
            (r.root/'logs'/f'{expected[-1]}.log').unlink()
            with self.assertRaisesRegex(g.GateClosed, 'batch log missing'):
                r.verify_batch_logs()



if __name__ == '__main__':
    unittest.main()
