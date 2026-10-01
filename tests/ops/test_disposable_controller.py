"""Offline, no credential or provider access. Fakes exercise the real controller/watchdog contracts."""
import importlib.util
import hashlib
import errno
import io
import json
import os
import shutil
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'scripts/ops/digitalocean-validation/controller.py'
spec = importlib.util.spec_from_file_location('disposable_controller', SOURCE)
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'private'
        self.root.mkdir(mode=0o700)
        fixed_root = patch.object(controller, 'FIXED_EVIDENCE_ROOT', self.root)
        fixed_root.start()
        self.addCleanup(fixed_root.stop)
        self.bundle = self.root / 'source.tar'
        self.bundle.write_bytes(b'archive fixture')
        import hashlib
        self.config = dict(run_id='w27w28-01', owner_id='controller01', evidence_root=str(self.root),
                           expected_commit='7fbf38ff3c2fb83d1ecf2e6f908197cf9a79c723',
                           source_bundle=str(self.bundle), source_sha256=hashlib.sha256(self.bundle.read_bytes()).hexdigest(),
                           snapshot_id='987654321', vpc_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                           ssh_key_id=123, ssh_key_fingerprint='aa:' * 15 + 'bb', key_path=str(self.root / 'id_ed25519'),
                           ssh_cidr='8.8.8.8/32', delete_authorized=True,
                           region='nyc1', size='s-8vcpu-16gb-amd', max_hours=4, max_usd='1.00',
                           backups=False, ipv6=False, monitoring=False, dns=None,
                           tool_sha256={name: 'a' * 64 for name in controller.TOOLS})

    def monitored_evidence(self):
        """Exercise the actual guard producer with a controlled host and 10 s clock."""
        if hasattr(self, '_monitor_files'):
            return self._monitor_files
        import test_disposable_contract as contract
        guard = contract.guard
        remote = self.root/'monitor-host'; (remote/'evidence').mkdir(parents=True)
        host = dict(busy=1, steal=0, iowait=0, load1=0, ncpu=8,
                    load_ratio=0, available_kib=4*1024**2, oom_total=0)
        clock = [0.0]
        with patch.object(guard, 'counters', return_value=(100, 10, 0, 0)), \
             patch.object(guard, 'host_read', side_effect=lambda prev: (prev, host.copy())), \
             patch.object(guard, 'emit'), \
             patch.object(guard.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(guard.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)):
            monitor = guard.Monitor(remote, self.config['run_id'])
            monitor.window('preflight')
            monitor.window('postflight')
        self.assertEqual(monitor.samples, 36)
        self._monitor_files = {name: (remote/'evidence'/name).read_bytes()
                               for name in ('samples.jsonl', 'monitor-diagnostics.jsonl')}
        return self._monitor_files

    def test_offline_check_rejects_placeholder_and_disallowed_paid_options(self):
        self.assertEqual(controller.validate_config(self.config)['run_id'], 'w27w28-01')
        for field, value in [('size', 's-2vcpu-4gb'), ('region', 'sfo3'), ('max_hours', 5),
                             ('max_usd', '2'), ('backups', True), ('monitoring', True),
                             ('dns', 'example.com'), ('snapshot_id', '000'), ('delete_authorized', False)]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    controller.validate_config({**self.config, field: value})

    def test_only_explicit_region_size_pairs_are_authorized(self):
        allowed = (('nyc1', 's-8vcpu-16gb-amd'), ('nyc3', 's-8vcpu-16gb-intel'))
        for region, size in allowed:
            with self.subTest(region=region, size=size):
                self.assertEqual(controller.validate_config({**self.config, 'region': region,
                                                             'size': size})['region'], region)
        for region, size in (('nyc1', 's-8vcpu-16gb-intel'),
                             ('nyc3', 's-8vcpu-16gb-amd'),
                             ('sfo3', 's-8vcpu-16gb-intel'),
                             ('nyc2', 's-8vcpu-16gb-amd')):
            with self.subTest(region=region, size=size), self.assertRaises(ValueError):
                controller.validate_config({**self.config, 'region': region, 'size': size})
        for field in ('region', 'size'):
            with self.subTest(field=field), self.assertRaises(ValueError):
                controller.validate_config({**self.config, field: ['nyc3']})

    def test_nyc3_preflight_binds_size_price_region_and_existing_vpc(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        class API:
            def __init__(self, **changes):
                self.calls = []
                self.size = {'slug': c['size'], 'vcpus': 8, 'memory': 16384,
                             'available': True, 'regions': ['nyc3'], 'price_hourly': '0.16667'}
                self.vpc = {'id': c['vpc_id'], 'region': 'nyc3'}
                for field, value in changes.items():
                    (self.vpc if field == 'vpc_region' else self.size)[
                        'region' if field == 'vpc_region' else field] = value
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                if method != 'GET': raise AssertionError('unexpected mutation')
                if '/droplets?' in path: return 200, {'droplets': [], 'meta': {'total': 0}, 'links': {}}
                if '/sizes?' in path: return 200, {'sizes': [self.size], 'meta': {'total': 1}, 'links': {}}
                if '/snapshots/' in path: return 200, {'snapshot': {'id': c['snapshot_id']}}
                if '/vpcs/' in path: return 200, {'vpc': self.vpc}
                if '/keys/' in path: return 200, {'ssh_key': {'id': c['ssh_key_id'],
                    'fingerprint': c['ssh_key_fingerprint'], 'public_key': 'ssh-ed25519 test'}}
                raise AssertionError(path)
        api = API()
        self.assertEqual(controller.preflight(api, c)[1], '0.16667')
        self.assertEqual(len(api.calls), 5)
        for changed in ({'vcpus': 4}, {'memory': 8192}, {'available': False},
                        {'regions': ['nyc1']}, {'price_hourly': '0.25001'},
                        {'vpc_region': 'nyc1'}):
            with self.subTest(changed=changed):
                bad = API(**changed)
                with self.assertRaises(controller.Blocked): controller.preflight(bad, c)
                self.assertFalse(any(method != 'GET' for method, _, _ in bad.calls))

    def test_nyc3_droplet_post_and_manifest_use_configured_region(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        class StopAfterPost(Exception): pass
        class API:
            def __init__(self): self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                if (method, path) == ('POST', '/v2/tags'):
                    return 201, {'tag': {'name': payload['name']}}
                if (method, path) == ('GET', '/v2/tags/apollo-validation-' + c['run_id']):
                    return 200, {'tag': {'name': path.removeprefix('/v2/tags/')}}
                if (method, path) == ('POST', '/v2/firewalls'):
                    return 201, {'firewall': {'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}
                if (method, path) == ('GET', '/v2/firewalls/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'):
                    return 200, {'firewall': {'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                                             'name': 'apollo-validation-' + c['run_id'],
                                             'tags': ['apollo-validation-' + c['run_id']],
                                             'droplet_ids': []}}
                if (method, path) == ('POST', '/v2/droplets'): raise StopAfterPost
                raise AssertionError((method, path))
        api = API()
        class Loader:
            @staticmethod
            def load_token(): return 'fixture-only'
        with patch.object(controller, 'check_artifacts', return_value=1), \
             patch.object(controller, 'OfficialAPI', return_value=api), \
             patch.object(controller, 'preflight', return_value=({'fingerprint': c['ssh_key_fingerprint']}, '0.16667')), \
             patch.object(controller, 'local_login_key', return_value=object()), \
             patch.object(controller, 'host_key', return_value=(self.root / 'host', 'fixture', 'fixture')), \
             patch.object(controller, 'cloud_init', return_value='#cloud-config\n'):
            with self.assertRaises(StopAfterPost): controller.execute(c, Loader())
        failed = [json.loads(line) for line in (self.root / c['run_id'] / 'controller.jsonl').read_text().splitlines()][-1]
        self.assertEqual((failed['status'], failed['phase'], failed['callsite'], failed['error_type']),
                         ('needs_owner_intervention', 'droplet_create', 'execute', 'StopAfterPost'))
        posts = [(path, payload) for method, path, payload in api.calls if method == 'POST']
        self.assertEqual([path for path, _ in posts], ['/v2/tags', '/v2/firewalls', '/v2/droplets'])
        self.assertEqual(posts[-1][1]['region'], c['region'])
        self.assertEqual(posts[-1][1]['size'], c['size'])
        self.assertEqual(posts[-1][1]['vpc_uuid'], c['vpc_id'])
        self.assertEqual((posts[-1][1]['backups'], posts[-1][1]['ipv6'], posts[-1][1]['monitoring']),
                         (False, False, False))
        droplet = {'id': 12345, 'created_at': '2030-01-01T00:00:00Z'}
        m = controller.manifest(c, self.root / c['run_id'], droplet,
                                {'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
                                {'pid': 1234, 'deadlineUTC': '2030-01-01T01:00:00Z'})
        self.assertEqual((m['region'], m['size']), (c['region'], c['size']))

    def test_nyc3_readback_region_mismatch_blocks_before_deletion(self):
        import test_watchdog as fixtures
        fixture = fixtures.WatchdogTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        m, api = fixture.m, fixture.api
        m.update(region='nyc3', size='s-8vcpu-16gb-intel')
        api.droplet['droplet'].update(region={'slug': 'nyc1'}, size_slug=m['size'])
        self.assertEqual(fixtures.watchdog.run(m, api, mode='delete'), 'blocked_identity')
        self.assertEqual(api.deletes, [])

    def test_nyc3_creation_readback_requires_matching_region(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        droplet = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                   'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                   'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                   'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        class API:
            def request(self, method, path, payload=None):
                self_outer.assertEqual((method, path), ('GET', '/v2/droplets/12345'))
                return 200, {'droplet': droplet}
        self_outer = self
        self.assertEqual(controller.fresh_droplet(API(), 12345, c, name, droplet)[1], '8.8.8.8')
        droplet['region'] = {'slug': 'nyc1'}
        with self.assertRaises(controller.Blocked):
            controller.fresh_droplet(API(), 12345, c, name, droplet)

    def test_droplet_readback_waits_for_new_identity_then_active_and_network(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        full = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        class API:
            def __init__(self, snapshots): self.snapshots = iter(snapshots); self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path))
                return 200, {'droplet': next(self.snapshots)}
        clock = [0]
        def sleep(seconds): clock[0] += seconds
        partial = {'id': 12345, 'name': name, 'status': 'new', 'vpc_uuid': None,
                   'region': None, 'created_at': None}
        api = API([partial, {**full, 'networks': {'v4': []}}, full])
        with patch.object(controller.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(controller.time, 'sleep', side_effect=sleep):
            self.assertEqual(controller.fresh_droplet(api, 12345, c, name,
                {'id': 12345, 'name': name, 'vpc_uuid': None})[1], '8.8.8.8')
        self.assertEqual(api.calls, [('GET', '/v2/droplets/12345')] * 3)
        self.assertEqual(clock[0], 10)

    def test_empty_public_ip_waits_for_get_only_then_accepts_global_ipv4(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        full = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        class API:
            def __init__(self, snapshots): self.snapshots = iter(snapshots); self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                return 200, {'droplet': next(self.snapshots)}
        blank = {**full, 'networks': {'v4': [{'type': 'public', 'ip_address': ''}]}}
        api = API([blank, full])
        clock = [0]
        with patch.object(controller.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(controller.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
             patch.object(controller, 'open_pinned_ssh', side_effect=AssertionError('SSH forbidden')):
            self.assertEqual(controller.fresh_droplet(api, 12345, c, name,
                {'id': 12345, 'name': name})[1], '8.8.8.8')
        self.assertEqual(api.calls, [('GET', '/v2/droplets/12345', None)] * 2)
        self.assertEqual(clock[0], 5)

    def test_empty_public_ip_times_out_without_ssh_or_mutation(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        blank = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                 'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                 'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                 'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': ''}]}}
        class API:
            def __init__(self): self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                return 200, {'droplet': blank}
        api = API()
        clock = [0]
        with patch.object(controller.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(controller.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
             patch.object(controller, 'open_pinned_ssh', side_effect=AssertionError('SSH forbidden')):
            with self.assertRaisesRegex(controller.Blocked, 'droplet_readback_timeout:.*public_ip=missing'):
                controller.fresh_droplet(api, 12345, c, name, {'id': 12345, 'name': name})
        self.assertEqual(clock[0], 600)
        self.assertTrue(api.calls)
        self.assertEqual({method for method, _, _ in api.calls}, {'GET'})

    def test_nonempty_bad_public_ip_and_multiple_addresses_block(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        full = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                'status': 'active'}
        class API:
            def __init__(self, addresses): self.addresses = addresses; self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                return 200, {'droplet': {**full, 'networks': {'v4': self.addresses}}}
        for address in ('not-an-ip', '10.0.0.1', '2001:4860:4860::8888'):
            with self.subTest(address=address):
                api = API([{'type': 'public', 'ip_address': address}])
                with self.assertRaisesRegex(controller.Blocked, 'public_ip:invalid'):
                    controller.fresh_droplet(api, 12345, c, name, {'id': 12345, 'name': name})
                self.assertEqual(len(api.calls), 1)
        api = API([{'type': 'public', 'ip_address': ''},
                   {'type': 'public', 'ip_address': '8.8.8.8'}])
        with self.assertRaisesRegex(controller.Blocked, 'public_ip:multiple'):
            controller.fresh_droplet(api, 12345, c, name, {'id': 12345, 'name': name})
        self.assertEqual(len(api.calls), 1)

    def test_valid_post_and_different_fractional_final_timestamp_bind_cleanup(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        final = '2030-01-01T00:00:37.123456Z'
        droplet = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                   'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                   'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': final,
                   'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        class API:
            def request(self, method, path, payload=None):
                self_outer.assertEqual((method, path, payload), ('GET', '/v2/droplets/12345', None))
                return 200, {'droplet': droplet}
        self_outer = self
        observed, ip = controller.fresh_droplet(API(), 12345, c, name,
                                                 {'id': 12345, 'name': name, 'created_at': '2030-01-01T00:00:00Z'})
        self.assertEqual((observed['created_at'], ip), (final, '8.8.8.8'))
        m = controller.manifest(c, self.root / c['run_id'], observed,
                                {'id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
                                {'pid': 1234, 'deadlineUTC': '2030-01-01T01:00:00Z'})
        self.assertEqual(m['created_at'], final)
        self.assertEqual(m['not_before'], int(controller.stamp(final)))
        with patch.object(controller.time, 'time', return_value=controller.stamp(final) + 60):
            self.assertEqual(controller.remaining_guard_seconds(controller.stamp(observed['created_at'])), 10620)

    def test_invalid_final_timestamp_still_blocks(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        full = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                'image': {'slug': 'ubuntu-24-04-x64'}, 'status': 'active',
                'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        class API:
            def __init__(self, value): self.value = value; self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                return 200, {'droplet': {**full, 'created_at': self.value}}
        for invalid in ('not-a-timestamp', '2030-01-01T00:00:00+00:00', '', 123):
            with self.subTest(invalid=invalid):
                api = API(invalid)
                with self.assertRaisesRegex(controller.Blocked, 'readback.created_at'):
                    controller.fresh_droplet(api, 12345, c, name,
                                             {'id': 12345, 'name': name, 'created_at': '2030-01-01T00:00:00Z'})
                self.assertEqual(len(api.calls), 1)

    def test_region_and_image_objects_without_usable_slug_fail_closed(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        full = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        class API:
            def __init__(self, value): self.value = value; self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                return 200, {'droplet': self.value}
        for field in ('region', 'image'):
            for shape in ('absent', 'none', 'empty'):
                for source in ('post', 'new', 'active'):
                    with self.subTest(field=field, shape=shape, source=source):
                        nested = {} if shape == 'absent' else {'slug': None if shape == 'none' else ''}
                        posted = {'id': 12345, 'name': name}
                        d = {**full, 'status': 'new' if source == 'new' else 'active'}
                        (posted if source == 'post' else d)[field] = nested
                        api = API(d)
                        with self.assertRaisesRegex(controller.Blocked, field):
                            controller.fresh_droplet(api, 12345, c, name, posted)
                        self.assertLessEqual(len(api.calls), 1)

    def test_droplet_readback_known_contradictions_fail_immediately(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        full = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        wrong = {'region': {'slug': 'nyc1'}, 'size_slug': 'other',
                 'vpc_uuid': 'different', 'tags': ['other'], 'image': {'slug': 'other'}}
        class API:
            def __init__(self, droplet): self.droplet = droplet; self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path))
                return 200, {'droplet': self.droplet}
        for source in ('post', 'new', 'active'):
            for field, value in wrong.items():
                with self.subTest(source=source, field=field):
                    posted = {'id': 12345, 'name': name}
                    d = dict(full if source != 'new' else {**full, 'status': 'new'})
                    if source == 'post': posted[field] = value
                    else: d[field] = value
                    api = API(d)
                    with self.assertRaisesRegex(controller.Blocked, field) as failure:
                        controller.fresh_droplet(api, 12345, c, name, posted)
                    self.assertNotIn('different', str(failure.exception))
                    self.assertLessEqual(len(api.calls), 1)
        for source in ('post', 'readback'):
            for field, value in (('id', 12346), ('name', 'other')):
                with self.subTest(source=source, field=field):
                    posted = {'id': 12345, 'name': name}
                    d = dict(full)
                    (posted if source == 'post' else d)[field] = value
                    with self.assertRaisesRegex(controller.Blocked, field):
                        controller.fresh_droplet(API(d), 12345, c, name, posted)

    def test_droplet_active_missing_identity_and_bad_states_fail_closed(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        full = {'id': 12345, 'name': name, 'tags': [name], 'region': {'slug': 'nyc3'},
                'size_slug': c['size'], 'vpc_uuid': c['vpc_id'],
                'image': {'slug': 'ubuntu-24-04-x64'}, 'created_at': '2030-01-01T00:00:00Z',
                'status': 'active', 'networks': {'v4': [{'type': 'public', 'ip_address': '8.8.8.8'}]}}
        class API:
            def __init__(self, value): self.value = value
            def request(self, method, path, payload=None): return 200, {'droplet': self.value}
        for field in ('tags', 'region', 'size_slug', 'vpc_uuid', 'image', 'created_at'):
            for absent in ('missing', None):
                with self.subTest(field=field, absent=absent):
                    d = dict(full)
                    if absent == 'missing': d.pop(field)
                    else: d[field] = None
                    with self.assertRaisesRegex(controller.Blocked, field):
                        controller.fresh_droplet(API(d), 12345, c, name, {'id': 12345, 'name': name})
        for status in ('off', 'archive', None, {'unexpected': 'secret'}):
            with self.subTest(status=status), self.assertRaisesRegex(controller.Blocked, 'droplet_state'):
                controller.fresh_droplet(API({**full, 'status': status}), 12345, c, name,
                                         {'id': 12345, 'name': name})
        for malformed in (None, [], {'id': 12345, 'name': name, 'status': 'active',
                                     'region': 'secret-value'}):
            with self.subTest(malformed=type(malformed)), self.assertRaises(controller.Blocked) as failure:
                controller.fresh_droplet(API(malformed), 12345, c, name, {'id': 12345, 'name': name})
            self.assertNotIn('secret-value', str(failure.exception))

    def test_droplet_incomplete_new_times_out_without_mutation_or_ssh(self):
        c = controller.validate_config({**self.config, 'region': 'nyc3', 'size': 's-8vcpu-16gb-intel'})
        name = 'apollo-validation-' + c['run_id']
        class API:
            def __init__(self): self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path, payload))
                return 200, {'droplet': {'id': 12345, 'name': name, 'status': 'new', 'vpc_uuid': None}}
        api = API()
        clock = [0]
        with patch.object(controller.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(controller.time, 'sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
             patch.object(controller, 'open_pinned_ssh', side_effect=AssertionError('SSH forbidden')):
            with self.assertRaisesRegex(controller.Blocked, 'droplet_readback_timeout.*vpc_uuid'):
                controller.fresh_droplet(api, 12345, c, name, {'id': 12345, 'name': name})
        self.assertTrue(api.calls)
        self.assertEqual({method for method, _, _ in api.calls}, {'GET'})
        self.assertEqual(clock[0], 600)

    def test_cross_process_lock_is_exclusive_not_a_chat_lease(self):
        lock = str(self.root / 'apollo-validation-owner.lock')
        with controller.watchdog.claim_lock(lock):
            child = subprocess.run([sys.executable, '-c',
                'import importlib.util,sys; s=importlib.util.spec_from_file_location("w",sys.argv[1]);'
                'w=importlib.util.module_from_spec(s);s.loader.exec_module(w);'
                'with_lock=w.claim_lock(sys.argv[2]);'
                'next(with_lock.__enter__() for _ in range(1))',
                str(controller.WATCHDOG_PATH), lock], capture_output=True, timeout=10)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn(b'OwnerActive', child.stderr)
            with self.assertRaises(controller.watchdog.OwnerActive):
                with controller.watchdog.claim_lock(lock):
                    pass

    def test_inventory_requires_all_pages_and_rejects_ambiguous_apollo_test(self):
        class API:
            def __init__(self): self.calls = []
            def request(self, method, path, payload=None):
                self.calls.append((method, path))
                if path.endswith('page=1'):
                    return 200, {'droplets': [{'id': 1, 'name': 'other', 'tags': []}],
                                 'meta': {'total': 2}, 'links': {'pages': {'next': 'https://api.digitalocean.com/v2/droplets?per_page=200&page=2'}}}
                return 200, {'droplets': [{'id': 2, 'name': 'apollo-validation-prior', 'tags': []}],
                             'meta': {'total': 2}, 'links': {'pages': {}}}
        api = API()
        with self.assertRaises(controller.Blocked): controller.require_empty_inventory(api)
        self.assertEqual(len(api.calls), 2)
        self.assertEqual(api.calls[0][0], 'GET')

    def test_post_intent_not_retried_after_timeout(self):
        class API:
            count = 0
            def request(self, method, path, payload=None):
                self.count += 1
                raise TimeoutError('no response')
        api = API()
        with self.assertRaises(TimeoutError):
            controller.create_once(api, self.root, 'w27w28-01', 'droplet', '/v2/droplets', {'name': 'test'})
        with self.assertRaises(controller.Blocked):
            controller.create_once(api, self.root, 'w27w28-01', 'droplet', '/v2/droplets', {'name': 'test'})
        self.assertEqual(api.count, 1)

    def test_rate_and_identity_gate_before_any_post(self):
        class API:
            def __init__(self, price): self.price = price; self.calls = []; self.config = config
            def request(self, method, path, payload=None):
                self.calls.append((method, path))
                if method != 'GET': raise AssertionError('unexpected mutation')
                if '/droplets?' in path: return 200, {'droplets': [], 'meta': {'total': 0}, 'links': {}}
                if '/sizes?' in path:
                    return 200, {'sizes': [{'slug': 's-8vcpu-16gb-amd', 'vcpus': 8,
                          'memory': 16384, 'available': True, 'regions': ['nyc1'],
                          'price_hourly': self.price}], 'meta': {'total': 1}, 'links': {}}
                if '/snapshots/' in path: return 200, {'snapshot': {'id': self.config['snapshot_id']}}
                if '/vpcs/' in path: return 200, {'vpc': {'id': self.config['vpc_id'], 'region': 'nyc1'}}
                if '/keys/' in path: return 200, {'ssh_key': {'id': 123,
                    'fingerprint': self.config['ssh_key_fingerprint'], 'public_key': 'ssh-ed25519 test'}}
                raise AssertionError(path)
        config = self.config
        for price in ('0.26', 'NaN', '-1'):
            api = API(price)
            with self.subTest(price=price), self.assertRaises(controller.Blocked):
                controller.preflight(api, self.config)
            self.assertEqual([method for method, _ in api.calls], ['GET', 'GET'])
        api = API('0.249')
        self.assertEqual(controller.preflight(api, self.config)[1], '0.249')
        self.assertEqual(len(api.calls), 5)

    def test_generated_host_key_is_pinned_and_not_login_key(self):
        import paramiko
        key_path, private, public = controller.host_key(self.root)
        self.assertEqual(paramiko.Ed25519Key.from_private_key_file(str(key_path)).get_name(), 'ssh-ed25519')
        self.assertTrue(public.startswith('ssh-ed25519 '))
        cloud = controller.cloud_init(private, public)
        self.assertIn('ssh_keys:\n  ed25519_private: |', cloud)
        self.assertIn('  ed25519_public: ' + public, cloud)
        self.assertNotIn('Bearer', cloud)

    def test_real_watchdog_contract_blocks_ssh_loss_and_deletes_after_readback(self):
        import test_watchdog as fixtures
        fixture = fixtures.WatchdogTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        m, api = fixture.m, fixture.api
        self.config.update({k: m[k] for k in ('run_id', 'owner_id', 'expected_commit',
                                              'snapshot_id', 'vpc_id', 'region', 'size')})
        self.config['evidence_root'] = m['evidence_root']
        run_dir = Path(m['postflight_file']).parent
        postflight = Path(m['postflight_file']).read_bytes()
        samples = (run_dir / 'samples.jsonl').read_bytes()
        diagnostics = self.monitored_evidence()['monitor-diagnostics.jsonl']

        class Transport:
            active = False
            def is_active(self): return self.active
        transport = Transport()
        class SSH:
            closed = False
            def get_transport(self): return transport
            def close(self): self.closed = True
        ssh = SSH()
        class SFTP:
            closed = False
            def lstat(self, path):
                content = (postflight if path.endswith('postflight.json') else
                           diagnostics if path.endswith('monitor-diagnostics.jsonl') else
                           b'bad mp4' if path.endswith('.mp4') else samples)
                return type('Stat', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(content)})()
            def open(self, path, mode):
                return io.BytesIO(postflight if path.endswith('postflight.json') else
                                  diagnostics if path.endswith('monitor-diagnostics.jsonl') else
                                  b'bad mp4' if path.endswith('.mp4') else samples)
            def listdir_attr(self, path):
                return [type('Stat', (), {'filename': 'project-a-final.mp4',
                        'st_mode': stat.S_IFREG | 0o600, 'st_size': 7})()]
            def close(self): self.closed = True
        sftp = SFTP()
        owner = {'pid': m['owner_pid'], 'deadlineUTC': m['owner_deadline_utc']}
        droplet = {'id': m['droplet_id'], 'created_at': m['created_at']}
        firewall = {'id': m['firewall_id']}
        held = {'path': m['lockfile'], 'active': True}
        with fixtures.watchdog.claim_lock(m['lockfile']):
            with self.assertRaises(controller.Blocked):
                controller.finish_and_delete(self.config, run_dir, api, ssh, sftp, owner, 0,
                                             droplet, firewall, held)
            self.assertEqual(api.calls, [])
            self.assertFalse(ssh.closed)
            transport.active = True
            Path(m['postflight_file']).unlink()
            (run_dir / 'samples.jsonl').unlink()
            record, status, acceptance = controller.finish_and_delete(self.config, run_dir, api, ssh, sftp,
                                                            owner, 0, droplet, firewall, held)
            self.assertTrue(ssh.closed and sftp.closed)
            self.assertEqual(status, 'deleted_verified')
            self.assertEqual(record['work_outcome'], 'success')
            self.assertEqual(acceptance['status'], 'failed')
            self.assertIn('synthetic-phase-gate.png', acceptance['missing'])
            self.assertIn('visual_mp4_header', acceptance['errors'])
            self.assertEqual(len(api.deletes), 3)
            self.assertFalse(any('snapshot' in p for p in api.deletes))

    def test_owner_pid_deadline_and_exit_cannot_be_invented(self):
        import test_watchdog as fixtures
        fixture = fixtures.WatchdogTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        m = fixture.m
        for changed in ({'pid': m['owner_pid'] + 1, 'deadlineUTC': m['owner_deadline_utc']},
                        {'pid': m['owner_pid'], 'deadlineUTC': '2030-01-01T00:00:00Z'}):
            with self.subTest(changed=changed), self.assertRaises(controller.Blocked):
                controller.verify_postflight(m, changed, 0)
        with self.assertRaises(controller.Blocked):
            controller.verify_postflight(m, {'pid': m['owner_pid'],
                                             'deadlineUTC': m['owner_deadline_utc']}, 1)

    def test_visual_readback_rejects_invalid_mp4_even_if_sftp_says_regular(self):
        data = {**self.monitored_evidence(), 'postflight.json': b'{}',
                'batch-results.jsonl': b'{}\n', 'visual.mp4': b'not an MP4'}
        class SFTP:
            def lstat(self, path):
                content = data[path.split('/')[-1]]
                return type('Stat', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(content)})()
            def open(self, path, mode): return io.BytesIO(data[path.split('/')[-1]])
            def listdir_attr(self, path):
                return [type('Stat', (), {'filename': 'visual.mp4', 'st_mode': stat.S_IFREG | 0o600,
                                          'st_size': len(data['visual.mp4'])})()]
        run_dir = self.root / 'visual-run'
        run_dir.mkdir(mode=0o700)
        record, acceptance = controller.collect_evidence(SFTP(), self.config, run_dir)
        self.assertEqual(record, {})
        self.assertEqual(acceptance['status'], 'failed')
        self.assertIn('visual_mp4_header', acceptance['errors'])
        self.assertTrue((run_dir / 'visual-inventory.json').is_file())

    def test_monitor_diagnostics_collected_sanitized_before_failed_postflight_gate(self):
        import test_watchdog as fixtures
        fixture = fixtures.WatchdogTest(); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        m = fixture.m
        self.config['run_id'] = m['run_id']
        run_dir = Path(m['postflight_file']).parent
        post = json.loads(Path(m['postflight_file']).read_text())
        post.update(exit_code=1, cleanup_ok=False, cleanup_outcome='unverified',
                    work_outcome='failed', work_errors=['monitor failure'], error='monitor failure',
                    errors=['monitor failure'])
        sample = (run_dir/'samples.jsonl').read_bytes()
        diagnosis = (b'{"kind":"sample","sequence":1,"stage":"continuous",'
                     b'"monotonic_at":100.0,"duration_seconds":4.0,"outcome":"failed"}\n'
                     b'{"kind":"probe","sequence":1,"stage":"continuous",'
                     b'"monotonic_at":100.0,"duration_seconds":4.0,"outcome":"timeout",'
                     b'"probe":"docker.top.runner","timeout_seconds":4,"terminated":true,"return_code":-15,"url":"do-not-copy"}\n')
        payload = {'postflight.json': json.dumps(post).encode(), 'samples.jsonl': sample,
                   'monitor-diagnostics.jsonl': diagnosis, 'batch-results.jsonl': b'{}\n'}
        class SFTP:
            def lstat(self, path):
                data = payload[path.split('/')[-1]]
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_size=len(data))
            def open(self, path, mode): return io.BytesIO(payload[path.split('/')[-1]])
            def listdir_attr(self, path): return []
        from types import SimpleNamespace
        record, acceptance = controller.collect_evidence(SFTP(), self.config, self.root)
        self.assertEqual(record['work_outcome'], 'failed')
        self.assertEqual(acceptance['status'], 'failed')
        trace = self.root/'monitor-diagnostics.jsonl'
        self.assertTrue(trace.is_file())
        self.assertNotIn('do-not-copy', trace.read_text())
        self.assertEqual(json.loads(trace.read_text().splitlines()[-1])['probe'], 'docker.top.runner')
        self.assertEqual([json.loads(line) for line in (self.root/'samples.jsonl').read_text().splitlines()],
                         [json.loads(line) for line in sample.splitlines()])
        self.assertEqual(len(self.root.joinpath('samples.jsonl').read_text().splitlines()), 36)
        self.assertFalse(controller.watchdog.terminal_ready({**m, 'postflight_file': str(self.root/'postflight.json')}))

    def test_monitor_diagnostics_conservative_full_run_producer_to_consumer(self):
        import test_disposable_contract as contract
        guard = contract.guard
        remote = self.root/'full-monitor'; (remote/'evidence').mkdir(parents=True)
        host = dict(busy=1, steal=0, iowait=0, load1=0, ncpu=8,
                    load_ratio=0, available_kib=4*1024**2, oom_total=0)
        with patch.object(guard, 'counters', return_value=(100, 10, 0, 0)):
            monitor = guard.Monitor(remote, self.config['run_id'])
        monitor.pg = 'run-pg'; monitor.runner = 'run-runner'
        def probe(probe_id, observer):
            observer(probe_id, 'started', 4, 0, None, None)
            observer(probe_id, 'completed', 4, .01, True, 0)
        def identity(name, run, **kw):
            probe(kw['probe_id'], kw['observer'])
            return True, 123
        def command(argv, **kw):
            probe(kw['probe_id'], kw['observer'])
            return '1|40|0|0'
        def find_next(name, **kw):
            probe('docker.top.runner', kw['observer'])
            return False, None
        reads = [0]
        def host_read(previous):
            reads[0] += 1
            if reads[0] == 1301: raise guard.GateClosed('host read failed')
            return previous, host.copy()
        with patch.object(guard, 'host_read', side_effect=host_read), \
             patch.object(guard, 'container_identity', side_effect=identity), \
             patch.object(guard, 'command', side_effect=command), \
             patch.object(monitor, 'find_next', side_effect=find_next), patch.object(guard, 'emit'):
            for _ in range(1300): monitor.sample('continuous')
            with self.assertRaisesRegex(guard.GateClosed, 'host read failed'):
                monitor.sample('postflight')
        raw = (remote/'evidence'/'monitor-diagnostics.jsonl').read_bytes()
        self.assertEqual(len(raw.splitlines()), 13002)
        self.assertLessEqual(len(raw), 4 * 1024 * 1024)
        from types import SimpleNamespace
        class SFTP:
            def lstat(self, path):
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_size=len(raw))
            def open(self, path, mode): return io.BytesIO(raw)
        parsed = controller.monitor_diagnostics(
            controller.read_sftp(SFTP(), 'monitor-diagnostics.jsonl', 4 * 1024 * 1024))
        self.assertEqual(len(parsed.splitlines()), 13002)
        self.assertEqual(json.loads(parsed.splitlines()[-1])['outcome'], 'failed')
        self.assertEqual(len(controller.sanitized_samples((remote/'evidence'/'samples.jsonl').read_bytes()).splitlines()), 1300)

    def test_monitor_diagnostics_missing_or_malformed_blocks_collection(self):
        from types import SimpleNamespace
        source = self.monitored_evidence()
        for label, diagnosis in [('missing', None), ('truncated', source['monitor-diagnostics.jsonl'][:-1]),
                                 ('invalid', b'{"kind":"sample","sequence":1}\n')]:
            with self.subTest(label=label):
                payload = {'postflight.json': b'{}', 'samples.jsonl': source['samples.jsonl']}
                if diagnosis is not None: payload['monitor-diagnostics.jsonl'] = diagnosis
                class SFTP:
                    def lstat(self, path):
                        name = path.rsplit('/', 1)[-1]
                        if name not in payload: raise IOError('missing diagnosis')
                        return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_size=len(payload[name]))
                    def open(self, path, mode): return io.BytesIO(payload[path.rsplit('/', 1)[-1]])
                run_dir = self.root/label; run_dir.mkdir()
                with self.assertRaises((IOError, controller.Blocked)):
                    controller.collect_evidence(SFTP(), self.config, run_dir)
                self.assertFalse((run_dir/'samples.jsonl').exists())

    def test_public_metadata_allowlist_sanitizes_nested_fields_and_retains_ids(self):
        mp4 = b'\x00\x00\x00\x0cftyp' + b'fixture'
        digest = hashlib.sha256(mp4).hexdigest()
        names = controller.PUBLIC_JSON
        files = {name: json.dumps({'outputKey': 'artifact/ref', 'reportId': 'report-123',
                 'nested': [{'authorization': 'Bearer sensitive', 'apiToken': 'sensitive',
                             'cookie': 'sensitive', 'senha': 'sensitive', 'secretValue': 'sensitive'}],
                 'real': {'verified': True}, 'outputSha256': digest,
                 'productionRunId': 'production-id'}).encode() for name in names}
        files['result.json'] = json.dumps({'runId': self.config['run_id'],
            'nested': [{'authorization': 'Bearer sensitive'}]}).encode()
        for project in ('a', 'b'):
            identity: dict[str, Any] = {field: f'{field}-{project}-opaque' for field in (
                'workspaceId', 'projectId', 'projectVersionId', 'productionRunId',
                'publicOperationId', 'outputArtifactId', 'outputManifestId')}
            identity.update(outputSha256=digest, attempt=1, outputKey='artifact/ref',
                            reportId='report-123', nested=[{'authorization': 'Bearer sensitive',
                            'apiToken': 'sensitive', 'cookie': 'sensitive', 'senha': 'sensitive',
                            'secretValue': 'sensitive'}])
            terminal = {'operation': {'id': identity['publicOperationId'], 'status': 'succeeded',
                         'phase': 'completed'}, 'checkpoint': {'outputSha256': digest, 'attempt': 1},
                        'qualityReport': {**{key: identity[key] for key in (
                            'workspaceId', 'projectId', 'projectVersionId', 'productionRunId',
                            'publicOperationId', 'outputArtifactId', 'outputManifestId', 'outputSha256')},
                            'passed': True},
                        'attestation': {'identity': {'commitSha': self.config['expected_commit']}}}
            files[f'project-{project}-final-render-identity.json'] = json.dumps(identity).encode()
            files[f'project-{project}-final-render-terminal.json'] = json.dumps(terminal).encode()
        files.update({'postflight.json': b'{"work_outcome":"success"}',
                      **self.monitored_evidence(), 'batch-results.jsonl': b'{}\n',
                      'synthetic-phase-gate.png': b'\x89PNG\r\n\x1a\nfixture',
                      'project-a-final.mp4': mp4, 'project-b-final.mp4': mp4,
                      'next.log': b'sensitive', 'private.env': b'sensitive'})
        class SFTP:
            def lstat(self, path):
                content = files[path.rsplit('/', 1)[-1]]
                return type('Stat', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(content)})()
            def open(self, path, mode): return io.BytesIO(files[path.rsplit('/', 1)[-1]])
            def listdir_attr(self, path):
                return [type('Stat', (), {'filename': name, 'st_mode': stat.S_IFREG | 0o600,
                        'st_size': len(content)})() for name, content in files.items()
                        if name not in ('postflight.json', 'samples.jsonl', 'monitor-diagnostics.jsonl', 'batch-results.jsonl')]
        run_dir = self.root / 'metadata'
        run_dir.mkdir(mode=0o700)
        _, acceptance = controller.collect_evidence(SFTP(), self.config, run_dir)
        self.assertEqual(acceptance, {'status': 'passed', 'missing': [], 'errors': []})
        saved = json.loads((run_dir / 'visual-project-a-final-render-identity.json').read_text())
        self.assertEqual((saved['outputKey'], saved['reportId']), ('artifact/ref', 'report-123'))
        self.assertEqual(set(saved['nested'][0].values()), {'[REDACTED]'})
        self.assertFalse((run_dir / 'visual-next.log').exists())
        self.assertFalse((run_dir / 'visual-private.env').exists())
        inventory = json.loads((run_dir / 'visual-inventory.json').read_text())
        self.assertEqual(len(inventory['renders']), 2)
        self.assertEqual(len(inventory['collected']), len(names) + 3)

    def test_render_binding_rejects_blank_mismatch_other_run_and_commit(self):
        mp4 = b'\x00\x00\x00\x0cftyp' + b'fixture'
        digest = hashlib.sha256(mp4).hexdigest()
        fields = ('workspaceId', 'projectId', 'projectVersionId', 'productionRunId',
                  'publicOperationId', 'outputArtifactId', 'outputManifestId', 'outputSha256')

        def fixture():
            files: dict[str, Any] = {'postflight.json': b'{"work_outcome":"success"}',
                     **self.monitored_evidence(), 'batch-results.jsonl': b'{}\n',
                     'result.json': json.dumps({'runId': self.config['run_id'],
                         'nested': [{'authorization': 'Bearer sensitive'}]}).encode(),
                     'synthetic-phase-gate.png': b'\x89PNG\r\n\x1a\nfixture',
                     'synthetic-phase-gate-history-browser.json': b'{"real":true}',
                     'transformation-critic-report-viewer-browser.json': b'{"real":true}'}
            for project in ('a', 'b'):
                identity: dict[str, Any] = {field: f'{field}-{project}-opaque' for field in fields[:-1]}
                identity.update(outputSha256=digest, attempt=1)
                terminal = {'operation': {'id': identity['publicOperationId'], 'status': 'succeeded',
                                          'phase': 'completed'},
                            'checkpoint': {'outputSha256': digest, 'attempt': 1},
                            'qualityReport': {**{key: identity[key] for key in fields}, 'passed': True},
                            'attestation': {'identity': {'commitSha': self.config['expected_commit']}}}
                files[f'project-{project}-final.mp4'] = mp4
                files[f'project-{project}-final-render-identity.json'] = identity
                files[f'project-{project}-final-render-terminal.json'] = terminal
            return files

        def collect(files, label):
            class SFTP:
                def lstat(self, path):
                    content = self.content(path)
                    return type('Stat', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(content)})()
                def content(self, path):
                    name = path.rsplit('/', 1)[-1]
                    if name not in files: raise IOError('missing producer file')
                    data = files[name]
                    return json.dumps(data).encode() if isinstance(data, dict) else data
                def open(self, path, mode): return io.BytesIO(self.content(path))
                def listdir_attr(self, path):
                    return [type('Stat', (), {'filename': name, 'st_mode': stat.S_IFREG | 0o600,
                            'st_size': len(self.content(name))})() for name in files
                            if name not in ('postflight.json', 'samples.jsonl', 'monitor-diagnostics.jsonl', 'batch-results.jsonl')]
            run_dir = self.root / label
            run_dir.mkdir()
            return controller.collect_evidence(SFTP(), self.config, run_dir)[1], run_dir

        valid, run_dir = collect(fixture(), 'valid')
        self.assertEqual(valid, {'status': 'passed', 'missing': [], 'errors': []})
        self.assertEqual(json.loads((run_dir / 'visual-result.json').read_text())['runId'],
                         self.config['run_id'])
        self.assertEqual(json.loads((run_dir / 'visual-result.json').read_text())['nested'][0],
                         {'authorization': '[REDACTED]'})
        mutations = []
        for field in fields[:-1]:
            for value in ('', '  ', 'different-opaque-id'):
                mutations.append((f'identity-{field}-{repr(value)}',
                    lambda f, field=field, value=value: f['project-a-final-render-identity.json'].__setitem__(field, value)))
            mutations.append((f'report-{field}', lambda f, field=field:
                f['project-a-final-render-terminal.json']['qualityReport'].__setitem__(field, 'other-id')))
        mutations.extend([
            ('identity-hash', lambda f: f['project-a-final-render-identity.json'].__setitem__('outputSha256', '0' * 64)),
            ('report-hash', lambda f: f['project-a-final-render-terminal.json']['qualityReport'].__setitem__('outputSha256', '0' * 64)),
            ('checkpoint-hash', lambda f: f['project-a-final-render-terminal.json']['checkpoint'].__setitem__('outputSha256', '0' * 64)),
            ('operation-id', lambda f: f['project-a-final-render-terminal.json']['operation'].__setitem__('id', 'other-id')),
            ('operation-status', lambda f: f['project-a-final-render-terminal.json']['operation'].__setitem__('status', 'waiting')),
            ('attempt-bool', lambda f: f['project-a-final-render-identity.json'].__setitem__('attempt', True)),
            ('attempt-mismatch', lambda f: f['project-a-final-render-terminal.json']['checkpoint'].__setitem__('attempt', 2)),
            ('attempt-missing', lambda f: f['project-a-final-render-identity.json'].pop('attempt')),
            ('report-project-missing', lambda f: f['project-a-final-render-terminal.json']['qualityReport'].pop('projectId')),
            ('terminal-missing', lambda f: f.pop('project-a-final-render-terminal.json')),
            ('quality-failed', lambda f: f['project-a-final-render-terminal.json']['qualityReport'].__setitem__('passed', False)),
            ('old-commit', lambda f: f['project-a-final-render-terminal.json']['attestation']['identity'].__setitem__('commitSha', '0' * 40)),
            ('project-b-commit', lambda f: f['project-b-final-render-terminal.json']['attestation']['identity'].__setitem__('commitSha', '0' * 40)),
            ('other-run', lambda f: f.__setitem__('result.json', b'{"runId":"other-run"}')),
        ])
        for index, (label, mutate) in enumerate(mutations):
            with self.subTest(label=label):
                files = fixture()
                mutate(files)
                acceptance, _ = collect(files, f'invalid-{index}')
                self.assertEqual(acceptance['status'], 'failed', acceptance)

    def test_success_without_required_browser_json_fails_acceptance(self):
        files = {'postflight.json': b'{"work_outcome":"success"}',
                 **self.monitored_evidence(), 'batch-results.jsonl': b'{}\n'}
        class SFTP:
            def lstat(self, path):
                content = files[path.rsplit('/', 1)[-1]]
                return type('Stat', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(content)})()
            def open(self, path, mode): return io.BytesIO(files[path.rsplit('/', 1)[-1]])
            def listdir_attr(self, path): return []
        run_dir = self.root / 'missing'
        run_dir.mkdir(mode=0o700)
        _, acceptance = controller.collect_evidence(SFTP(), self.config, run_dir)
        self.assertEqual(acceptance['status'], 'failed')
        self.assertIn('transformation-critic-report-viewer-browser.json', acceptance['missing'])
        self.assertIn('project-b-final.mp4', acceptance['missing'])

    def test_required_sample_readback_failure_never_becomes_editorial_only(self):
        class SFTP:
            def lstat(self, path): raise IOError('missing required proof')
        run_dir = self.root / 'no-proof'
        run_dir.mkdir(mode=0o700)
        with self.assertRaises(IOError):
            controller.collect_evidence(SFTP(), self.config, run_dir)
        self.assertFalse((run_dir / 'visual-inventory.json').exists())

    def test_failed_batch_phase_diagnostic_is_collected_before_delete_without_raw_secrets(self):
        import test_watchdog as fixtures
        fixture = fixtures.WatchdogTest(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        m, api = fixture.m, fixture.api
        self.config.update({k: m[k] for k in ('run_id', 'owner_id', 'expected_commit',
                                              'snapshot_id', 'vpc_id', 'region', 'size')})
        run_dir = Path(m['postflight_file']).parent
        post = json.loads(Path(m['postflight_file']).read_text())
        post.update(work_outcome='failed', exit_code=124)
        secret = 'CANARY-private-secret-123'
        log = (b'Prisma schema loaded from prisma/v2/schema.prisma\n'
               + f'postgresql://user:{secret}@localhost/db?token={secret}\nAuthorization: Bearer\n{secret}\npassword={secret}\n'.encode())
        files = {'postflight.json': json.dumps(post).encode(),
                 'samples.jsonl': (run_dir / 'samples.jsonl').read_bytes(),
                 'monitor-diagnostics.jsonl': self.monitored_evidence()['monitor-diagnostics.jsonl'],
                 'batch-results.jsonl': b'{"phase":"prisma-generate","exit_code":124}\n',
                 'prisma-generate.log': log}
        for existing in ('postflight.json', 'samples.jsonl'):
            (run_dir / existing).unlink()
        events = []
        class SFTP:
            def lstat(self, path):
                events.append(('read', path))
                content = files[path.rsplit('/', 1)[-1]]
                return type('Stat', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(content)})()
            def open(self, path, mode): return io.BytesIO(files[path.rsplit('/', 1)[-1]])
            def listdir_attr(self, path): return []
            def close(self): events.append(('close', ''))
        class SSH:
            def get_transport(self):
                return type('Transport', (), {'is_active': lambda self: True})()
            def close(self): events.append(('ssh_close', ''))
        def delete(*args, **kwargs):
            events.append(('delete', ''))
            return 'deleted_verified'
        with patch.object(controller.watchdog, 'run', side_effect=delete), \
             patch.object(controller.watchdog, 'terminal_ready', return_value=True), \
             patch.object(controller.watchdog, 'validate_manifest'):
            controller.finish_and_delete(self.config, run_dir, api, SSH(), SFTP(),
                {'pid': m['owner_pid'], 'deadlineUTC': m['owner_deadline_utc']}, 124,
                {'id': m['droplet_id'], 'created_at': m['created_at']},
                {'id': m['firewall_id']}, {'active': True, 'path': m['lockfile']})
        saved = (run_dir / 'failed-phase-diagnostic.json').read_text()
        self.assertIn('prisma-generate', saved)
        self.assertIn('schema loaded', saved)
        self.assertNotIn(secret, saved)
        self.assertNotIn('postgresql://', saved)
        self.assertLess(next(i for i, e in enumerate(events) if e[0] == 'read' and e[1].endswith('prisma-generate.log')),
                        next(i for i, e in enumerate(events) if e[0] == 'delete'))

    def test_failed_phase_diagnostic_rejects_unknown_phase_missing_symlink_and_oversize(self):
        from types import SimpleNamespace
        for phase, mode, content in ((['prisma-generate'], stat.S_IFREG, b'x'),
                                     ('../secret', stat.S_IFREG, b'x'),
                                     ('prisma-generate', stat.S_IFLNK, b'x'),
                                     ('prisma-generate', stat.S_IFREG, b'x' * 65537),
                                     ('prisma-generate', stat.S_IFREG, None)):
            with self.subTest(phase=phase, mode=mode, size=len(content or b'')):
                class SFTP:
                    def lstat(self, path):
                        if content is None: raise FileNotFoundError(errno.ENOENT, 'absent')
                        return SimpleNamespace(st_mode=mode, st_size=len(content))
                    def open(self, path, mode):
                        if content is None or phase == '../secret' or len(content) > 65536 or not stat.S_ISREG(mode):
                            raise AssertionError('unsafe read')
                        return io.BytesIO(content)
                run = self.root / ('diagnostic-' + str(len(list(self.root.glob('diagnostic-*')))))
                run.mkdir()
                controller.collect_failed_phase(SFTP(), self.config, run, phase, 124)
                result = json.loads((run / 'failed-phase-diagnostic.json').read_text())
                self.assertEqual(result['status'], 'unavailable')
                self.assertFalse((run / 'prisma-generate.log').exists())

    def test_focused_ci_probe_contract_preserves_budget_and_real_generator(self):
        source = SOURCE.parents[0] / 'prisma-phase-probe.sh'
        text = source.read_text()
        self.assertIn('Dockerfile.runner', text)
        self.assertIn('npm ci --prefix remotion', text)
        self.assertIn('npm run db:v2:generate', text)
        self.assertIn('timeout --signal=TERM --kill-after=15s 180s', text)
        self.assertIn('--cpus=1.5', text)
        self.assertIn('--memory=9g', text)
        self.assertIn('--memory-swap=9g', text)
        self.assertIn('--cpuset-cpus=0,1', text)
        self.assertIn('trap cleanup EXIT', text)
        self.assertNotIn('DEBUG=*', text)
        for flag in ('--network=host', '--pids-limit=1536', '--shm-size=512m', '--init'):
            self.assertIn(flag, text)
        self.assertIn('work_exit_code', text)
        self.assertIn('cleanup_verified', text)
        self.assertIn('memory.peak', text)
        self.assertIn('cpu.stat', text)
        self.assertIn('source_sha256', text)

    def test_probe_snapshot_parses_real_cgroup_fields(self):
        text = (SOURCE.parent / 'prisma-phase-probe.sh').read_text()
        parser = text.split("python3 -c 'import json,re,sys\n", 1)[1].split("' > \"$evidence/cgroup-", 1)[0]
        fixture = ('cpu.stat\nusage_usec 123\nuser_usec 45\ncore_sched.force_idle_usec 7\n'
                   'memory.current\n4096\nmemory.peak\n8192\n'
                   'memory.events\noom 0\noom_kill 1\n')
        result = subprocess.run([sys.executable, '-c', 'import json,re,sys\n' + parser],
                                input=fixture, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            'cpu.stat': {'usage_usec': 123, 'user_usec': 45, 'core_sched.force_idle_usec': 7},
            'memory.current': {'value': 4096}, 'memory.peak': {'value': 8192},
            'memory.events': {'oom': 0, 'oom_kill': 1}})
        unsafe = fixture.replace('oom 0', 'oom;bad 0')
        rejected = subprocess.run([sys.executable, '-c', 'import json,re,sys\n' + parser],
                                  input=unsafe, text=True, capture_output=True)
        self.assertNotEqual(rejected.returncode, 0)

    def test_failed_phase_diagnostic_counts_discarded_material_without_leaking(self):
        from types import SimpleNamespace
        secret = b'CANARY-do-not-publish'
        raw = b'Prisma schema loaded from prisma/v2/schema.prisma\n' + secret + b'\n' + b'x\n' * 35
        class SFTP:
            def lstat(self, path):
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_size=len(raw))
            def open(self, path, mode): return io.BytesIO(raw)
        controller.collect_failed_phase(SFTP(), self.config, self.root, 'prisma-generate', 124)
        saved = json.loads((self.root/'failed-phase-diagnostic.json').read_text())
        self.assertEqual(saved['status'], 'filtered_excerpt')
        self.assertEqual(saved['filter_category'], 'exact_safe_lines_only')
        self.assertEqual(saved['source_bytes'], len(raw))
        self.assertEqual(saved['discarded_lines'], 36)
        self.assertNotIn(secret.decode(), json.dumps(saved))

    def test_real_batch_phase_timeout_124_preserves_log_and_result(self):
        # Source only the production phase function; no Docker, PG or full guard.
        shell = SOURCE.parents[1] / 'digitalocean-bootstrap' / 'batch-phase.sh'
        log = self.root / 'logs'; log.mkdir()
        evidence = self.root / 'evidence'; evidence.mkdir()
        script = 'source "$1"; LOG="$2"; EVID="$3"; phase prisma-generate 1 bash -c "printf safe-marker; sleep 3"'
        bash = ('C:/Program Files/Git/usr/bin/bash.exe' if os.name == 'nt' else 'bash')
        paths = [str(path).replace('\\', '/') for path in (shell, log, evidence)]
        result = subprocess.run([str(bash), '-c', script, 'batch-fixture', *paths],
                                capture_output=True, timeout=12)
        self.assertEqual(result.returncode, 124, (result.stderr, result.stdout,
            (log / 'prisma-generate.log').read_bytes() if (log / 'prisma-generate.log').exists() else b'no log'))
        self.assertIn(b'safe-marker', (log / 'prisma-generate.log').read_bytes())
        self.assertEqual(json.loads((evidence / 'batch-results.jsonl').read_text()),
                         {'phase': 'prisma-generate', 'exit_code': 124})

    def test_cli_nonzero_on_failed_work_or_acceptance_even_after_verified_delete(self):
        import contextlib
        for work, acceptance, expected in (('success', 'passed', 0),
                                            ('failed', 'passed', 1),
                                            ('success', 'failed', 1)):
            with self.subTest(work=work, acceptance=acceptance), \
                 patch.object(controller, 'validate_config', return_value=self.config), \
                 patch.object(controller.watchdog, 'read_record', return_value=self.config), \
                 patch.object(controller, 'check_artifacts', return_value=7), \
                 patch.object(controller, 'load_private_loader', return_value=object()), \
                 patch.object(controller, 'execute', return_value={
                     'status': 'deleted_verified', 'cleanup_outcome': 'deleted_verified',
                     'work_outcome': work, 'acceptance': {'status': acceptance}}), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                code = controller.main(['--execute', '--config', str(self.root / 'no-config'),
                                        '--token-loader', str(self.root / 'no-loader')])
            self.assertEqual(code, expected)
            self.assertEqual(json.loads(output.getvalue())['status'], 'deleted_verified')

    def test_guard_deadline_uses_elapsed_time_not_fresh_three_hours(self):
        import time
        with self.assertRaises(controller.Blocked):
            controller.remaining_guard_seconds(time.time() - 10800)
        valid = controller.remaining_guard_seconds(time.time() - 60)
        self.assertGreater(valid, 10000)
        self.assertLess(valid, 10800)

    def test_transfer_failure_records_safe_phase_and_preserves_primary_error(self):
        class SFTP:
            def lstat(self, path): raise FileNotFoundError(errno.ENOENT, 'absent')
            def open(self, path, mode): raise TimeoutError('private-path argv authorization=secret')
        run_dir = self.root / 'failure'; run_dir.mkdir()
        with self.assertRaises(TimeoutError):
            controller.transfer_source(SFTP(), self.bundle, '/remote', self.config['source_sha256'],
                                       run_dir, lambda: None, time.monotonic() + 10)
        rows = [json.loads(line) for line in (run_dir / 'controller.jsonl').read_text().splitlines()]
        self.assertEqual([r['status'] for r in rows], ['transfer_started', 'transfer_failed'])
        self.assertEqual(rows[-1]['error_type'], 'TimeoutError')
        self.assertEqual(rows[-1]['operation'], 'upload_open')
        self.assertEqual(rows[-1]['phase'], 'upload')
        self.assertEqual(rows[-1]['callsite'], 'transfer_source')
        self.assertGreaterEqual(rows[-1]['duration_seconds'], 0)
        self.assertTrue(rows[-1]['at_utc'].endswith('Z'))
        self.assertNotIn('secret', (run_dir / 'controller.jsonl').read_text())

    def test_remote_lstat_only_enoent_allows_open(self):
        class SFTP:
            def __init__(self, error): self.error = error; self.opens = []
            def lstat(self, path): raise self.error
            def open(self, path, mode):
                self.opens.append((path, mode))
                raise AssertionError('open forbidden after failed stat')
        for error in (TimeoutError('private argv secret'), PermissionError(errno.EACCES, 'private path')):
            for operation in ('tool', 'source'):
                with self.subTest(error=type(error).__name__, operation=operation):
                    sftp = SFTP(error)
                    run_dir = self.root / ('stat-' + str(len(list(self.root.glob('stat-*')))))
                    run_dir.mkdir()
                    with self.assertRaises(type(error)):
                        if operation == 'tool':
                            controller.remote_write(sftp, '/remote/tool', b'fixture')
                        else:
                            controller.transfer_source(sftp, self.bundle, '/remote', self.config['source_sha256'],
                                                       run_dir, lambda: None, time.monotonic() + 10)
                    self.assertFalse(sftp.opens)
                    if operation == 'source':
                        row = json.loads((run_dir / 'controller.jsonl').read_text().splitlines()[-1])
                        self.assertEqual((row['phase'], row['operation'], row['error_type']),
                                         ('upload', 'upload_open', type(error).__name__))

    def test_transfer_upload_budget_is_not_extended_by_guard_deadline(self):
        clock = [0.0]
        class SFTP:
            def __init__(self): self.bytes = b''; self.marker_attempted = False
            def lstat(self, path):
                if path.endswith('upload.complete') or not self.bytes:
                    raise FileNotFoundError(errno.ENOENT, 'missing')
                return type('Info', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(self.bytes)})()
            def open(self, path, mode):
                if path.endswith('upload.complete'):
                    self.marker_attempted = True
                    raise AssertionError('marker after expired upload budget')
                if mode == 'rb': return io.BytesIO(self.bytes)
                parent = self
                class Output(io.BytesIO):
                    def write(inner, data):
                        parent.bytes += data
                        return len(data)
                return Output()
            def chmod(self, path, mode): pass
        sftp = SFTP(); run_dir = self.root / 'upload-budget'; run_dir.mkdir()
        def pump():
            if sftp.bytes: clock[0] = 1200.01
        with patch.object(controller.time, 'monotonic', side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(controller.Blocked, 'guard_deadline_unknown'):
                controller.transfer_source(sftp, self.bundle, '/remote', self.config['source_sha256'],
                                           run_dir, pump, 3600)
        self.assertFalse(sftp.marker_attempted)
        self.assertEqual(json.loads((run_dir / 'controller.jsonl').read_text().splitlines()[-1])['status'],
                         'transfer_failed')

    def test_transfer_checks_between_sftp_packet_sized_calls(self):
        archive = self.root / 'chunks.tar'; archive.write_bytes(b'A' * (2 * 1024 * 1024 + 7))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        class SFTP:
            def __init__(self): self.files = {}; self.writes = []; self.reads = []
            def lstat(self, path):
                if path not in self.files: raise FileNotFoundError(errno.ENOENT, 'missing')
                return type('Info', (), {'st_mode': stat.S_IFREG | 0o600,
                                         'st_size': len(self.files[path])})()
            def open(self, path, mode):
                if mode == 'rb':
                    parent = self
                    class Input(io.BytesIO):
                        def read(inner, count=None):
                            parent.reads.append(-1 if count is None else count)
                            return super().read(-1 if count is None else count)
                    return Input(self.files[path])
                parent = self
                class Output(io.BytesIO):
                    def write(inner, data):
                        parent.writes.append(len(data))
                        return super().write(data)
                    def close(inner):
                        parent.files[path] = inner.getvalue()
                        super().close()
                return Output()
            def chmod(self, path, mode): pass
        sftp = SFTP(); run_dir = self.root / 'packet-size'; run_dir.mkdir()
        self.assertEqual(controller.transfer_source(sftp, archive, '/remote', digest, run_dir,
                                                    lambda: None, time.monotonic() + 30), digest)
        self.assertEqual(sftp.files['/remote/source.tar'], archive.read_bytes())
        self.assertEqual(sftp.files['/remote/upload.complete'], (digest + '\n').encode())
        self.assertTrue(sftp.writes and sftp.reads)
        self.assertLessEqual(max(sftp.writes), 32768)
        self.assertLessEqual(max(sftp.reads), 32768)

    def test_execute_failure_journal_cannot_mask_primary_error(self):
        class Loader:
            def load_token(self): return 'fake-only'
        original = controller.journal
        def failing_final(run_dir, status, **fields):
            if status == 'needs_owner_intervention': raise OSError('journal-private-path')
            return original(run_dir, status, **fields)
        with patch.object(controller, 'check_artifacts', return_value=1), \
             patch.object(controller, 'OfficialAPI', return_value=object()), \
             patch.object(controller, 'preflight', side_effect=TimeoutError('argv secret')), \
             patch.object(controller, 'journal', side_effect=failing_final):
            with self.assertRaisesRegex(TimeoutError, 'argv secret'):
                controller.execute(self.config, Loader())
        self.assertFalse((self.root / self.config['run_id'] / 'result.json').exists())

    def test_transfer_deadline_and_result_block_marker_between_chunks(self):
        class Output(io.BytesIO):
            def __exit__(self, *args): pass
        class SFTP:
            def __init__(self): self.files = {}; self.writes = []
            def lstat(self, path):
                if path not in self.files: raise FileNotFoundError(errno.ENOENT, 'missing')
                return type('Info', (), {'st_mode': stat.S_IFREG | 0o600,
                                         'st_size': len(self.files[path])})()
            def open(self, path, mode):
                self.writes.append(path)
                if path.endswith('/upload.complete'): raise AssertionError('marker sent')
                class Sink(Output):
                    def write(inner, data):
                        self.files[path] = self.files.get(path, b'') + data
                        return len(data)
                return Sink()
            def chmod(self, path, mode): pass
        archive = self.root / 'large.tar'; archive.write_bytes(b'x' * (2 * 1024 * 1024))
        for error in (controller.Blocked('guard_result_during_upload'), controller.Blocked('guard_deadline_unknown')):
            with self.subTest(error=str(error)):
                sftp = SFTP(); run_dir = self.root / ('case-' + str(len(list(self.root.glob('case-*')))))
                run_dir.mkdir()
                calls = [0]
                def pump():
                    calls[0] += 1
                    if calls[0] == 2: raise error
                with self.assertRaises(controller.Blocked):
                    controller.transfer_source(sftp, archive, '/remote', hashlib.sha256(archive.read_bytes()).hexdigest(),
                                               run_dir, pump, time.monotonic() + 10)
                self.assertGreaterEqual(calls[0], 2)
                self.assertFalse(any(p.endswith('upload.complete') for p in sftp.writes))

    def test_guard_stderr_only_and_simultaneous_stdout_keep_result(self):
        class Channel:
            def __init__(self, stdout):
                self.stdout = stdout
                self.stderr = b'diagnostic\n'
                self.stdout_reads = 0
                self.stderr_reads = 0
                self.hold_open = False
                self.sftp_files = {}
            def settimeout(self, value): pass
            def exec_command(self, command): pass
            def recv_ready(self): return bool(self.stdout)
            def recv(self, count):
                if not self.stdout: raise AssertionError('stdout read while only stderr ready')
                self.stdout_reads += 1
                data, self.stdout = self.stdout, b''
                return data
            def recv_stderr_ready(self): return bool(self.stderr)
            def recv_stderr(self, count):
                self.stderr_reads += 1
                data, self.stderr = self.stderr, b''
                return data
            def exit_status_ready(self):
                return not self.stderr and (not self.hold_open or
                    any(path.endswith('upload.complete') for path in getattr(self, 'sftp_files', {})))
            def recv_exit_status(self): return 0
        class Transport:
            def __init__(self, channel): self.channel = channel
            def is_active(self): return True
            def open_session(self, timeout): return self.channel
        class SSH:
            def __init__(self, channel): self.transport = Transport(channel)
            def get_transport(self): return self.transport
        class SFTP:
            def __init__(self): self.files = {}
            def mkdir(self, path, mode): pass
            def lstat(self, path):
                if path not in self.files: raise FileNotFoundError(errno.ENOENT, 'not found')
                content = self.files[path]
                return type('Stat', (), {'st_mode': stat.S_IFREG | 0o600, 'st_size': len(content)})()
            def open(self, path, mode):
                if mode == 'wx':
                    files = self.files
                    class Output(io.BytesIO):
                        def close(inner):
                            files[path] = inner.getvalue()
                            super().close()
                    return Output()
                return io.BytesIO(self.files[path])
            def chmod(self, path, mode): pass
        for simultaneous in (False, True, 'partial'):
            with self.subTest(simultaneous=simultaneous):
                events = (json.dumps({'event': 'upload_ready', 'run_id': self.config['run_id'],
                    'root': '/opt/apollo-validation/' + str(self.config['run_id'])}).encode() + b'\n'
                    if simultaneous else b'') + (b'{"event":"result"' if simultaneous == 'partial' else b'{"event":"result"}\n')
                channel = Channel(events if simultaneous else b'')
                channel.hold_open = simultaneous == 'partial'
                if not simultaneous:
                    original = channel.recv_stderr
                    def stderr_then_result(count):
                        channel.stdout = events
                        return original(count)
                    channel.recv_stderr = stderr_then_result
                tool_digests = {tool: __import__('hashlib').sha256((controller.BOOTSTRAP / tool).read_bytes()).hexdigest()
                                for tool in controller.TOOLS}
                c = {**self.config, 'tool_sha256': tool_digests}
                owner = {'pid': 123, 'deadlineUTC': '2030-01-01T00:00:00Z'}
                sftp = SFTP()
                channel.sftp_files = sftp.files
                def write(sftp, path, source):
                    sftp.files[path] = source.read_bytes() if isinstance(source, Path) else source
                with patch.object(controller, 'remote_write', side_effect=write), patch.object(controller, 'read_sftp',
                    side_effect=lambda sftp, path, limit: (controller.BOOTSTRAP / path.split('/')[-1]).read_bytes()), \
                    patch.object(controller, 'owner_record', return_value=owner), \
                    patch.object(controller, 'remaining_guard_seconds', return_value=600):
                    if simultaneous:
                        expected = 'guard_event_incomplete_during_upload' if simultaneous == 'partial' else 'guard_result_during_upload'
                        with self.assertRaisesRegex(controller.Blocked, expected):
                            controller.guard_session(SSH(channel), sftp, c,
                                {'id': 12345, 'created_at': '2030-01-01T00:00:00Z'}, self.bundle, self.root)
                        self.assertNotIn('/opt/apollo-validation/' + c['run_id'] + '/upload.complete', sftp.files)
                    else:
                        observed, exit_code, uploaded = controller.guard_session(SSH(channel), sftp, c,
                            {'id': 12345, 'created_at': '2030-01-01T00:00:00Z'}, self.bundle, self.root)
                        self.assertEqual((observed, exit_code, uploaded), (owner, 0, False))
                self.assertGreaterEqual(channel.stdout_reads, 1)
                self.assertEqual(channel.stderr_reads, 1)


if __name__ == '__main__': unittest.main()
