"""Local producer→consumer contract: fake host readings, no cloud, Docker or SSH."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/ops/digitalocean-bootstrap'))
import remote_guard as guard
import test_watchdog as fixtures


class ProducerConsumerContract(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.WatchdogTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.m = self.fixture.m
        self.api = self.fixture.api

    def test_guard_sample_and_result_consumed_by_cleanup_without_api(self):
        root = Path(self.m['postflight_file']).parent
        config = {'run_id': self.m['run_id'], 'owner_id': self.m['owner_id'],
                  'root': '/opt/apollo-validation/' + self.m['run_id'],
                  'expected_droplet_id': self.m['droplet_id'],
                  'expected_commit': self.m['expected_commit'], 'source_sha256': 'a' * 64,
                  'duration_seconds': 7200}
        guard.validate_config(config)
        run = guard.Run(config)
        run.root = root.parent
        (run.root/'evidence').mkdir(exist_ok=True)
        host = dict(busy=1, steal=0, iowait=0, load1=0, ncpu=8,
                    load_ratio=0, available_kib=4 * 1024**2, oom_total=0)
        states = {run.runner: (True, 123), run.pg: (True, 456)}
        clock = [100.0]
        def advance(seconds):
            clock[0] += seconds
        def fake_command(argv, **kwargs):
            if argv[:2] == ['docker', 'stop']:
                states[argv[-1]] = (False, 0)
            if 'psql' in argv:
                return '0'  # controlled PG fake: no owned backend remains
            return 'false|0' if argv == ['docker', 'inspect'] else ''
        with patch.object(guard, 'counters', return_value=(100, 10, 0, 0)), \
             patch.object(guard, 'host_read', side_effect=lambda previous: (previous, host.copy())), \
             patch.object(guard, 'emit'), \
             patch.object(guard, 'command', side_effect=fake_command), \
             patch.object(guard, 'container_identity', side_effect=lambda name, run_id: states[name]), \
             patch.object(guard.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(guard.time, 'sleep', side_effect=advance):
            monitor = guard.Monitor(run.root, run.run)
            run.monitor = monitor
            monitor.window('preflight')
            run.step('runner', ['fake-runner'], scope=False)
            run.step('runner_exit', ['docker', 'inspect'], scope=False)
            run.create_attempted.update((run.runner, run.pg))
            def between_stops():
                advance(10)
                monitor.sample('cleanup_between_stops')
            with patch.object(monitor, 'await_sample', side_effect=between_stops):
                self.assertEqual(run.cleanup(), [])
            monitor.window('postflight')
            real_fstat = os.fstat
            def controlled_owner_stat(fd):
                info = real_fstat(fd)
                # Controlled root ownership for this synthetic lock, not proof of host root.
                # Keep real inode, size, type and mode for the production validator.
                return SimpleNamespace(st_mode=info.st_mode,
                                       st_uid=0 if info.st_uid != 0 else info.st_uid,
                                       st_dev=info.st_dev, st_ino=info.st_ino, st_size=info.st_size)
            with patch.object(guard.os, 'fstat', side_effect=controlled_owner_stat):
                with guard.owner_lock(run.run, config['duration_seconds'], root/'local-owner.lock') as owner:
                    run.owner_record = owner
                    self.m['owner_pid'] = os.getpid()
                    self.m['owner_deadline_utc'] = owner['deadlineUTC']
                    record = run.postflight_result(0, None, [])
        Path(self.m['postflight_file']).write_text(json.dumps(record))
        (root/'samples.jsonl').write_bytes((run.root/'evidence'/'samples.jsonl').read_bytes())
        self.assertEqual(record['samples'], 13)
        self.assertEqual(record['windows'], monitor.windows)
        for stage in ('preflight', 'postflight'):
            self.assertGreaterEqual(record['windows'][stage]['finished'] -
                                    record['windows'][stage]['started'], 60)
        self.assertEqual(record['container_states'], {'runner': 'stopped', 'pg': 'stopped'})
        self.assertEqual(record['orphan_backends'], 0)
        self.assertTrue(fixtures.watchdog.terminal_ready(fixtures.watchdog.validate_manifest(self.m)))
        self.assertEqual(self.api.calls, [])
        Path(root/'samples.jsonl').unlink()
        self.assertFalse(fixtures.watchdog.terminal_ready(fixtures.watchdog.validate_manifest(self.m)))


if __name__ == '__main__':
    unittest.main()
