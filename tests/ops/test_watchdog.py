"""Local-only contract tests; every API and deletion here is an in-memory fake."""
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'scripts/ops/digitalocean-cleanup/watchdog.py'
spec = importlib.util.spec_from_file_location('watchdog', SOURCE)
assert spec is not None and spec.loader is not None
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)


class FakeAPI:
    """Explicitly fake DigitalOcean responses; no network methods."""
    def __init__(self, m):
        self.m = m
        self.calls = []
        self.deleted = set()
        self.override = {}
        self.sticky = set()
        self.snapshot = {'snapshot': {'id': m['snapshot_id']}}
        self.droplet = {'droplet': {
            'id': m['droplet_id'], 'name': m['droplet_name'], 'tags': [m['tag']],
            'region': {'slug': m['region']}, 'size_slug': m['size'],
            'vpc_uuid': m['vpc_id'], 'created_at': m['created_at']}}
        self.firewall = {'firewall': {
            'id': m['firewall_id'], 'name': m['firewall_name'],
            'tags': [m['tag']], 'droplet_ids': []}}
        self.tag = {'tag': {'name': m['tag'], 'resources': {
            'count': 1, 'droplets': {'count': 1}, 'images': {'count': 0}}}}
        self.listing = {'droplets': [self.droplet['droplet']], 'links': {}, 'meta': {'total': 1}}

    def request(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        if (method, path) in self.override:
            return self.override[method, path]
        m = self.m
        if path == f'/v2/snapshots/{m["snapshot_id"]}' and method == 'GET':
            return 200, copy.deepcopy(self.snapshot)
        if path == f'/v2/droplets/{m["droplet_id"]}':
            return self.resource(method, 'droplet', self.droplet)
        if path == f'/v2/firewalls/{m["firewall_id"]}':
            return self.resource(method, 'firewall', self.firewall)
        if path == f'/v2/droplets?tag_name={m["tag"]}' and method == 'GET':
            result = copy.deepcopy(self.listing)
            if 'droplet' in self.deleted:
                result['droplets'], result['meta']['total'] = [], 0
            return 200, result
        if path == f'/v2/tags/{m["tag"]}':
            if 'tag' in self.deleted:
                return 404, {}
            result = copy.deepcopy(self.tag)
            if 'droplet' in self.deleted:
                result['tag']['resources']['count'] -= 1
                result['tag']['resources']['droplets']['count'] = 0
            return self.resource(method, 'tag', result)
        raise AssertionError('unexpected fake request')

    def resource(self, method, kind, body):
        if kind in self.deleted:
            return 404, {}
        if method == 'GET':
            return 200, copy.deepcopy(body)
        if method != 'DELETE':
            raise AssertionError('unexpected fake method')
        if kind not in self.sticky:
            self.deleted.add(kind)
        return 204, {}

    @property
    def deletes(self):
        return [path for method, path, _ in self.calls if method == 'DELETE']


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name) / 'private'
        root.mkdir(mode=0o700)
        now = time.time()
        created = dt.datetime.fromtimestamp(now - 3600, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        deadline = dt.datetime.fromtimestamp(now + 3600, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        self.m = {
            'run_id': 'synthetic-run-01', 'owner_id': 'synthetic-owner-01',
            'environment': 'disposable-validation', 'scope': 'apollo-validation',
            'owner_pid': 1234, 'owner_deadline_utc': deadline,
            'expected_commit': 'a' * 40,
            'droplet_id': 12345, 'firewall_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'snapshot_id': '987654321', 'vpc_id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'region': 'nyc1', 'size': 's-2vcpu-4gb', 'created_at': created,
            'not_before': int(now - 1), 'delete_authorized': True,
            'run_terminal_verified': True, 'owner_released': True,
            'incident_active': False, 'ssh_timeout_unresolved': False,
            'evidence_root': str(root),
            'lockfile': str(root / 'apollo-validation-owner.lock'),
            'postflight_file': str(root / 'synthetic-run-01' / 'postflight.json'),
            'prework_file': str(root / 'synthetic-run-01' / 'prework.json'),
        }
        self.names(self.m)
        self.postflight()
        self.api = FakeAPI(self.m)
        self.clock = [100.0]
        self.sleep = patch.object(watchdog.time, 'sleep', side_effect=lambda n: self.clock.__setitem__(0, self.clock[0] + n))
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        self.mono = patch.object(watchdog.time, 'monotonic', side_effect=lambda: self.clock[0])
        self.mono.start()
        self.addCleanup(self.mono.stop)

    def names(self, m):
        name = 'apollo-validation-' + m['run_id']
        m.update(droplet_name=name, firewall_name=name, tag=name)

    def postflight(self, **changes):
        windows = {'preflight': {'started': 0.0, 'finished': 300.0},
                   'postflight': {'started': 360.0, 'finished': 420.0}}
        record = {
            'run_id': self.m['run_id'], 'owner_id': self.m['owner_id'],
            'expected_droplet_id': self.m['droplet_id'],
            'source_commit': self.m['expected_commit'],
            'owner_pid': self.m['owner_pid'],
            'owner_deadline_utc': self.m['owner_deadline_utc'],
            'exit_code': 0, 'cleanup_ok': True, 'orphan_backends': 0,
            'work_outcome': 'success', 'work_errors': [],
            'cleanup_outcome': 'verified', 'cleanup_errors': [],
            'terminal_evidence': {
                'root_owned': True, 'root_identity': [1, 2],
                'runner': {'creation': 'created_verified', 'terminal': 'stopped'},
                'pg': {'creation': 'created_verified', 'terminal': 'stopped'},
                'backend_proof': 'observed_zero',
            },
            'container_states': {'runner': 'stopped', 'pg': 'stopped'},
            'errors': [], 'phases': [{'phase': 'pg_start', 'exit_code': 0},
                                    {'phase': 'runner_create', 'exit_code': 0},
                                    {'phase': 'runner', 'exit_code': 0},
                                    {'phase': 'runner_exit', 'exit_code': 0}], 'samples': 36,
            'windows': windows,
        }
        record.update(changes)
        path = Path(self.m['postflight_file'])
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_text(json.dumps(record), encoding='utf-8')
        sample = {'at': 1.0, 'busy': 1, 'steal': 0, 'iowait': 0,
                  'load1': 0, 'ncpu': 8, 'load_ratio': 0, 'available_kib': 4194304,
                  'oom_delta': 0, 'pg': 'N/A (not started)', 'app': 'N/A (not started)', 'reason': None}
        (path.parent/'samples.jsonl').write_text(''.join(json.dumps({**sample, 'stage': stage,
            'monotonic_at': float(tick)})+'\n' for stage, base, duration in
            (('preflight', 0, 300), ('postflight', 360, 60))
            for tick in range(base + 10, base + duration + 1, 10)), encoding='utf-8')

    def test_short_preflight_window_and_six_samples_cannot_authorize_delete(self):
        path = Path(self.m['postflight_file']).parent/'samples.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        short = [r for r in rows if r['stage'] == 'preflight'][:6]
        short += [r for r in rows if r['stage'] == 'postflight']
        short.sort(key=lambda row: row['monotonic_at'])
        for window, samples in (({'started': 0.0, 'finished': 60.0}, rows),
                                ({'started': 0.0, 'finished': 60.0}, short),
                                ({'started': 0.0, 'finished': 300.0}, short)):
            with self.subTest(window=window, samples=len(samples)):
                self.api = FakeAPI(self.m)
                self.postflight(samples=len(samples), windows={
                    'preflight': window, 'postflight': {'started': 360.0, 'finished': 420.0}})
                path.write_text(''.join(json.dumps(row)+'\n' for row in samples))
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assertEqual(self.api.calls, [])

    def run_it(self, mode='delete', m=None):
        return watchdog.run(self.m if m is None else m, self.api, mode=mode)

    def assert_no_delete(self):
        self.assertEqual(self.api.deletes, [])

    def test_two_runs_use_independent_validated_identity(self):
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.assertEqual(self.run_it(), 'already_deleted_verified')
        self.assertEqual(self.api.deletes, [
            f'/v2/droplets/{self.m["droplet_id"]}',
            f'/v2/firewalls/{self.m["firewall_id"]}', f'/v2/tags/{self.m["tag"]}'])
        self.assertTrue(all('snapshot' not in path for path in self.api.deletes))
        second = copy.deepcopy(self.m)
        second.update(run_id='synthetic-run-02', owner_id='synthetic-owner-02',
                      droplet_id=23456, snapshot_id='876543210',
                      firewall_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                      vpc_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                      evidence_root=str(Path(self.tmp.name) / 'private-02'))
        self.names(second)
        second['lockfile'] = str(Path(second['evidence_root']) / 'apollo-validation-owner.lock')
        second['postflight_file'] = str(Path(second['evidence_root']) / second['run_id'] / 'postflight.json')
        second['prework_file'] = str(Path(second['evidence_root']) / second['run_id'] / 'prework.json')
        Path(second['evidence_root']).mkdir(mode=0o700)
        self.m = second
        self.postflight()
        self.api = FakeAPI(second)
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.assertEqual(self.api.deletes[0], '/v2/droplets/23456')
        self.api = FakeAPI(second)
        self.api.droplet['droplet']['vpc_uuid'] = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        self.assertEqual(self.run_it(), 'blocked_identity')
        self.assert_no_delete()

    def test_firewall_tag_association_without_direct_droplet_is_valid(self):
        self.assertEqual(self.api.firewall['firewall']['droplet_ids'], [])
        self.assertEqual(self.run_it(), 'deleted_verified')

    def test_firewall_foreign_or_malformed_associations_block(self):
        for key, values in [('tags', []), ('tags', [self.m['tag'], 'other']),
                            ('droplet_ids', [7]), ('droplet_ids', [self.m['droplet_id'], 7]),
                            ('droplet_ids', [self.m['droplet_id'], self.m['droplet_id']]),
                            ('droplet_ids', ['12345']), ('droplet_ids', None)]:
            with self.subTest(key=key, values=values):
                self.api = FakeAPI(self.m)
                self.api.firewall['firewall'][key] = values
                self.assertEqual(self.run_it(), 'blocked_shared_resource')
                self.assert_no_delete()

    def test_foreign_tagged_droplet_blocks_before_delete(self):
        for entries in ([{'id': 7}], [{'id': self.m['droplet_id']}, {'id': 7}],
                        [{'id': True}], [{'id': self.m['droplet_id']}, {'id': self.m['droplet_id']}]):
            with self.subTest(entries=entries):
                self.api = FakeAPI(self.m)
                self.api.listing['droplets'] = entries
                self.api.listing['meta']['total'] = len(entries)
                self.assertIn(self.run_it(), ('blocked_shared_resource', 'blocked_api_error'))
                self.assert_no_delete()

    def test_snapshot_string_and_empty_links_are_valid(self):
        self.assertEqual(self.api.listing['links'], {})
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.api = FakeAPI(self.m)
        self.api.snapshot['snapshot']['id'] = int(self.m['snapshot_id'])
        self.assertEqual(self.run_it(), 'blocked_snapshot')
        self.assert_no_delete()

    def test_tag_listing_must_be_complete(self):
        for key, val in [('links', {'pages': {'next': 'https://example.invalid/page'}}),
                         ('links', []), ('links', {'pages': []}),
                         ('meta', {'total': 0}), ('meta', {'total': True})]:
            with self.subTest(key=key, val=val):
                self.api = FakeAPI(self.m)
                self.api.listing[key] = val
                self.assertNotEqual(self.run_it(), 'deleted_verified')
                self.assert_no_delete()

    def test_manifest_literal_validation_and_no_remote_calls(self):
        for field, bad in [('snapshot_id', 987654321), ('snapshot_id', '0987654321'),
                           ('snapshot_id', '987654321 '), ('snapshot_id', True),
                           ('droplet_id', True), ('droplet_id', '12345'),
                           ('firewall_id', 'not-a-uuid'), ('vpc_id', 'not-a-uuid'),
                           ('region', 'nyc1 '), ('run_id', '../evil'),
                           ('run_id', 'a' * 60), ('owner_id', ''),
                           ('environment', 'production'), ('scope', 'shared-production'),
                           ('delete_authorized', 1), ('created_at', 'invalid'),
                           ('owner_deadline_utc', '2020-01-01T00:00:00Z')]:
            with self.subTest(field=field, bad=bad):
                self.assertEqual(self.run_it(m={**self.m, field: bad}), 'blocked_manifest')
                self.assertEqual(self.api.calls, [])
        self.assertEqual(watchdog.validate_manifest({**self.m, 'owner_id': 'A_b-9'})['owner_id'], 'A_b-9')
        self.assertEqual(self.run_it(m={**self.m, 'owner_id': 'a' * 65}), 'blocked_manifest')
        for run in ('-bad', 'bad-', 'a' * 30):
            self.assertEqual(self.run_it(m={**self.m, 'run_id': run}), 'blocked_manifest')

    def test_paths_and_private_root_are_validated(self):
        for field, bad in [('evidence_root', 'relative'),
                           ('evidence_root', str(Path(__file__).resolve().parents[2])),
                           ('lockfile', str(Path(self.tmp.name) / 'other.lock')),
                           ('postflight_file', str(Path(self.tmp.name) / 'postflight.json')),
                           ('prework_file', str(Path(self.tmp.name) / 'prework.json')),
                           ('postflight_file', str(Path(self.m['evidence_root']) / '..' / 'outside'))]:
            with self.subTest(field=field):
                self.assertEqual(self.run_it(m={**self.m, field: bad}), 'blocked_manifest')
                self.assertEqual(self.api.calls, [])
        if os.name != 'nt':
            Path(self.m['evidence_root']).chmod(0o755)
            self.assertEqual(self.run_it(), 'blocked_manifest')
            self.assertEqual(self.api.calls, [])
            Path(self.m['evidence_root']).chmod(0o700)

    @unittest.skipIf(os.name == 'nt', 'POSIX permission bits required')
    def test_fixture_run_directory_is_private_and_delete_uses_it(self):
        directory = Path(self.m['postflight_file']).parent
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode) & 0o077, 0)
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.assertEqual(len(self.api.deletes), 3)

    @unittest.skipIf(os.name == 'nt', 'POSIX permission bits required')
    def test_public_run_directory_blocks_delete_before_any_intent(self):
        directory = Path(self.m['postflight_file']).parent
        directory.chmod(0o755)
        self.assertEqual(self.run_it(), 'blocked_api_error')
        self.assert_no_delete()
        self.assertEqual(list(directory.glob('delete-*.intent.json')), [])

    def test_symlinked_evidence_blocks(self):
        link = Path(self.tmp.name) / 'linked-postflight.json'
        try:
            link.symlink_to(self.m['postflight_file'])
        except (OSError, NotImplementedError):
            self.skipTest('symlinks unavailable')
        original = Path(self.m['postflight_file'])
        original.unlink()
        original.symlink_to(link)
        self.assertEqual(self.run_it(), 'blocked_manifest')
        self.assertEqual(self.api.calls, [])

    def test_prework_json_cannot_bypass_missing_postflight(self):
        Path(self.m['postflight_file']).unlink()
        Path(self.m['prework_file']).write_text(json.dumps({
            'run_id': self.m['run_id'], 'owner_id': self.m['owner_id'],
            'ssh_never_started': True, 'work_never_started': True,
            'recorded_before_work': True}), encoding='utf-8')
        self.m.update(run_terminal_verified=False, work_never_started=True)
        self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
        self.assertEqual(self.api.calls, [])

    def test_postflight_must_bind_owner_commit_droplet_and_terminal_state(self):
        cases = [
            {'run_id': 'synthetic-run-02'}, {'owner_id': 'foreign-owner'},
            {'expected_droplet_id': 7}, {'source_commit': 'b' * 40},
            {'owner_pid': 7}, {'owner_deadline_utc': '2025-01-01T00:00:00Z'},
            {'cleanup_ok': False}, {'orphan_backends': False},
            {'orphan_backends': 1}, {'container_states': {'runner': 'running', 'pg': 'stopped'}},
            {'container_states': {'runner': 'exited', 'pg': 'running'}},
            {'exit_code': True}, {'errors': ['unresolved']},
        ]
        for case in cases:
            with self.subTest(case=case):
                self.postflight(**case)
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assertEqual(self.api.calls, [])

    def test_failed_work_with_verified_cleanup_allows_only_disposable_deletion(self):
        self.postflight(exit_code=1, work_outcome='failed', work_errors=['editorial failed'],
                        error='editorial failed', errors=['editorial failed'],
                        phases=[{'phase': 'pg_start', 'exit_code': 0},
                                {'phase': 'runner_create', 'exit_code': 0},
                                {'phase': 'runner', 'exit_code': 1}])
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.assertEqual(len(self.api.deletes), 3)
        self.assertNotIn('/v2/snapshots/' + self.m['snapshot_id'], self.api.deletes)

    def test_never_created_requires_dispatch_and_explicit_not_applicable_backend(self):
        never = {'root_owned': True, 'root_identity': [1, 2],
                 'runner': {'creation': 'not_dispatched_verified', 'terminal': 'never_started'},
                 'pg': {'creation': 'not_dispatched_verified', 'terminal': 'never_started'},
                 'backend_proof': 'not_applicable_no_pg_created'}
        failed = dict(exit_code=1, work_outcome='failed', work_errors=['pre-PG failed'],
                      error='pre-PG failed', errors=['pre-PG failed'], phases=[{'phase': 'source_hash', 'exit_code': 1}],
                      container_states={'runner': 'never_started', 'pg': 'never_started'},
                      orphan_backends='N/A', terminal_evidence=never)
        self.postflight(**failed)
        self.assertEqual(self.run_it(), 'deleted_verified')
        for change in ({'orphan_backends': 0}, {'terminal_evidence': {**never, 'backend_proof': 'observed_zero'}},
                       {'phases': [{'phase': 'pg_start', 'exit_code': 1}]},
                       {'terminal_evidence': {**never, 'pg': {'creation': 'attempted', 'terminal': 'never_started'}}},
                       {'terminal_evidence': {**never, 'root_owned': False}}):
            with self.subTest(change=change):
                self.api = FakeAPI(self.m)
                self.postflight(**(failed | change))
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assert_no_delete()

    def test_contradictory_cleanup_and_work_records_never_delete(self):
        base = dict(exit_code=1, work_outcome='failed', work_errors=['failed'],
                    error='failed', errors=['failed'], phases=[{'phase': 'pg_start', 'exit_code': 0},
                                                              {'phase': 'runner_create', 'exit_code': 0},
                                                              {'phase': 'runner', 'exit_code': 1}])
        self.postflight(**base)
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.api = FakeAPI(self.m)
        terminal = json.loads(Path(self.m['postflight_file']).read_text())['terminal_evidence']
        for change in ({'work_errors': []}, {'exit_code': 0}, {'cleanup_errors': ['uncertain']},
                       {'cleanup_outcome': 'unverified'}, {'terminal_evidence': {'root_owned': True}},
                       {'terminal_evidence': {**terminal, 'backend_proof': 'not_applicable_no_pg_created'}},
                       {'orphan_backends': True}, {'container_states': {'runner': 'running', 'pg': 'stopped'}}):
            with self.subTest(change=change):
                self.postflight(**(base | change))
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assert_no_delete()

    def test_created_containers_need_successful_dispatch_phases_not_claims_only(self):
        for phases in ([{'phase': 'runner', 'exit_code': 0}, {'phase': 'runner_exit', 'exit_code': 0}],
                       [{'phase': 'pg_start', 'exit_code': 1}, {'phase': 'runner_create', 'exit_code': 0},
                        {'phase': 'runner', 'exit_code': 0}, {'phase': 'runner_exit', 'exit_code': 0}]):
            with self.subTest(phases=phases):
                self.postflight(phases=phases)
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assert_no_delete()

    def test_samples_must_be_actual_bounded_complete_stage_records(self):
        path = Path(self.m['postflight_file']).parent/'samples.jsonl'
        valid = path.read_text()
        for payload in ('', valid.replace('"preflight"', '"continuous"', 1),
                        valid.replace('"reason": null', '"reason": "busy"', 1),
                        valid + valid, valid + 'x' * (2 * 1024 * 1024),
                        valid.replace('"busy": 1', '"busy": null', 1)):
            with self.subTest(length=len(payload)):
                path.write_text(payload)
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assert_no_delete()
        path.write_text(valid)
        self.postflight(samples=11)
        self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
        self.assert_no_delete()
        path.unlink()
        self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
        self.assert_no_delete()

    def test_windows_and_monotonic_cadence_fail_closed_before_api(self):
        path = Path(self.m['postflight_file']).parent/'samples.jsonl'
        baseline = [json.loads(line) for line in path.read_text().splitlines()]
        cases = {
            'identical': lambda rows: [r.update(monotonic_at=123.0) for r in rows],
            'backwards': lambda rows: rows[31].update(monotonic_at=rows[30]['monotonic_at'] - 1),
            'gap': lambda rows: rows[2].update(monotonic_at=32.0),
            'first_late': lambda rows: rows[0].update(monotonic_at=12.0),
            'last_early': lambda rows: rows[29].update(monotonic_at=288.0),
            'outside': lambda rows: rows[30].update(monotonic_at=359.0),
            'missing': lambda rows: rows[0].pop('monotonic_at'),
            'boolean': lambda rows: rows[0].update(monotonic_at=True),
            'nonfinite': lambda rows: rows[0].update(monotonic_at=float('nan')),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                rows = copy.deepcopy(baseline)
                mutate(rows)
                path.write_text(''.join(json.dumps(r)+'\n' for r in rows))
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assert_no_delete()
        self.postflight()
        for bad in ({'started': 0.0, 'finished': 299.0},
                    {'started': True, 'finished': 300.0},
                    {'started': float('inf'), 'finished': 300.0},
                    {'started': 0.0, 'finished': 312.0}):
            with self.subTest(window=bad):
                windows = {'preflight': bad, 'postflight': {'started': 360.0, 'finished': 420.0}}
                self.postflight(windows=windows)
                self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
                self.assert_no_delete()
        self.postflight(windows={'preflight': {'started': 0.0, 'finished': 370.0},
                                 'postflight': {'started': 360.0, 'finished': 420.0}})
        self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
        self.assert_no_delete()
        self.postflight(windows={'preflight': {'started': 0.0, 'finished': 300.0}})
        self.assertEqual(self.run_it(), 'blocked_unverified_terminal')
        self.assert_no_delete()
        self.postflight()
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        path.write_text(''.join(json.dumps({**r, 'at': 123.0})+'\n' for r in rows))
        self.assertEqual(self.run_it(), 'deleted_verified')

    def test_manifest_gates_and_mutex_precede_all_api(self):
        for changes in [dict(owner_released=False), dict(incident_active=True),
                        dict(ssh_timeout_unresolved=True), dict(run_terminal_verified=False),
                        dict(delete_authorized=False)]:
            with self.subTest(changes=changes):
                self.assertNotEqual(self.run_it(m={**self.m, **changes}), 'deleted_verified')
                self.assertEqual(self.api.calls, [])
        with watchdog.claim_lock(self.m['lockfile']):
            self.assertEqual(self.run_it(), 'blocked_owner_active')
            self.assertEqual(self.api.calls, [])

    def test_inspect_only_get_and_check_only_local(self):
        self.m['delete_authorized'] = False
        self.assertEqual(self.run_it('check'), 'manifest_valid')
        self.assertEqual(self.api.calls, [])
        self.assertEqual(self.run_it('inspect'), 'identity_verified')
        self.assertEqual(self.api.deletes, [])
        self.assertEqual(self.run_it(), 'blocked_unauthorized')
        self.assertEqual(self.api.deletes, [])

    def test_pending_or_timeout_never_repeats_delete(self):
        self.api.sticky.add('droplet')
        self.assertEqual(self.run_it(), 'pending_droplet')
        self.assertEqual(self.run_it(), 'pending_droplet')
        self.assertEqual(self.api.deletes, [f'/v2/droplets/{self.m["droplet_id"]}'])
        self.api.deleted.add('droplet')
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.assertEqual(len(self.api.deletes), 3)

    def test_delayed_readback_uses_get_only(self):
        self.api.sticky.add('droplet')
        original = self.api.request
        count = [0]
        def delayed(method, path, payload=None):
            if method == 'GET' and path == f'/v2/droplets/{self.m["droplet_id"]}':
                count[0] += 1
                if count[0] == 10:
                    self.api.deleted.add('droplet')
            return original(method, path, payload)
        self.api.request = delayed
        self.assertEqual(self.run_it(), 'deleted_verified')
        self.assertGreater(count[0], 3)
        self.assertEqual(self.api.deletes.count(f'/v2/droplets/{self.m["droplet_id"]}'), 1)

    def test_transport_error_during_delete_never_retries(self):
        original = self.api.request
        def fail_delete(method, path, payload=None):
            if method == 'DELETE':
                self.api.calls.append((method, path, payload))
                raise TimeoutError('fake timeout with secret in body')
            return original(method, path, payload)
        self.api.request = fail_delete
        self.assertEqual(self.run_it(), 'blocked_api_error')
        self.assertEqual(self.run_it(), 'pending_droplet')
        self.assertEqual(len(self.api.deletes), 1)

    def test_firewall_changed_between_preflight_and_delete_blocks(self):
        original = self.api.request
        reads = [0]
        def switched(method, path, payload=None):
            if method == 'GET' and path == f'/v2/firewalls/{self.m["firewall_id"]}':
                reads[0] += 1
                if reads[0] == 2:
                    self.api.firewall['firewall']['tags'] = ['foreign-tag']
            return original(method, path, payload)
        self.api.request = switched
        self.assertEqual(self.run_it(), 'blocked_shared_resource')
        self.assertNotIn(f'/v2/firewalls/{self.m["firewall_id"]}', self.api.deletes)

    def test_droplet_changed_between_preflight_and_delete_blocks(self):
        original = self.api.request
        reads = [0]
        def switched(method, path, payload=None):
            if method == 'GET' and path == f'/v2/droplets/{self.m["droplet_id"]}':
                reads[0] += 1
                if reads[0] == 2:
                    self.api.droplet['droplet']['vpc_uuid'] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
            return original(method, path, payload)
        self.api.request = switched
        self.assertEqual(self.run_it(), 'blocked_identity')
        self.assert_no_delete()

    def test_cli_check_without_token_or_network(self):
        manifest = Path(self.tmp.name) / 'manifest.json'
        manifest.write_text(json.dumps(self.m), encoding='utf-8')
        env = os.environ.copy()
        env.pop('DIGITALOCEAN_ACCESS_TOKEN', None)
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        with patch.dict(os.environ, env, clear=True):
            result = subprocess.run([sys.executable, str(SOURCE), '--manifest', str(manifest),
                                     '--mode', 'check'], capture_output=True, text=True,
                                    timeout=10, env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'manifest_valid')
        self.assertNotIn('token', result.stdout.lower())

    def test_cli_accepts_relative_manifest_path(self):
        manifest = Path(self.tmp.name) / 'manifest.json'
        manifest.write_text(json.dumps(self.m), encoding='utf-8')
        env = os.environ.copy()
        env.pop('DIGITALOCEAN_ACCESS_TOKEN', None)
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        result = subprocess.run([sys.executable, str(SOURCE), '--manifest', 'manifest.json',
                                 '--mode', 'check'], cwd=self.tmp.name, capture_output=True,
                                text=True, timeout=10, env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'manifest_valid')


if __name__ == '__main__':
    unittest.main()
