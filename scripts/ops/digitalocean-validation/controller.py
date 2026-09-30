#!/usr/bin/env python3
"""One-shot, local-only owner for one approved DigitalOcean disposable validation.

No Hermes dependency. --check has no credential import/network. --execute requires a
private local token loader and is intentionally irreversible after a POST intent.
"""
import argparse
import errno
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import importlib.util
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

REPO = Path(__file__).resolve().parents[3]
FIXED_EVIDENCE_ROOT = Path.home() / 'AppData/Local/apollo-validation'
WATCHDOG_PATH = REPO / 'scripts/ops/digitalocean-cleanup/watchdog.py'
GUARD_PATH = REPO / 'scripts/ops/digitalocean-bootstrap/remote_guard.py'
BOOTSTRAP = GUARD_PATH.parent
spec = importlib.util.spec_from_file_location('apollo_disposable_watchdog', WATCHDOG_PATH)
assert spec is not None and spec.loader is not None
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)

BASE = 'https://api.digitalocean.com'
NAME_PREFIX = 'apollo-validation-'
TOOLS = ('remote_guard.py', 'batch.sh', 'Dockerfile.runner')
AUTHORIZED_PLANS = frozenset((('nyc1', 's-8vcpu-16gb-amd'),
                              ('nyc3', 's-8vcpu-16gb-intel')))
GET_PATH = re.compile(r'/v2/(?:droplets\?per_page=200&page=[1-9][0-9]*|sizes\?per_page=200&page=[1-9][0-9]*|droplets\?tag_name=apollo-validation-[a-z0-9-]+|(?:droplets|snapshots|account/keys)/[1-9][0-9]*|(?:vpcs|firewalls)/[0-9a-f-]{36}|tags/apollo-validation-[a-z0-9-]+)\Z')
POST_PATHS = {'/v2/tags', '/v2/firewalls', '/v2/droplets'}
DELETE_PATH = re.compile(r'/v2/(?:droplets/[1-9][0-9]*|firewalls/[0-9a-f-]{36}|tags/apollo-validation-[a-z0-9-]+)\Z')


class Blocked(RuntimeError):
    """Unknown or unsafe state; no automatic retry of remote mutation."""


class DropletReadbackBlocked(Blocked):
    """Field/state names only, safe to persist as operator diagnostics."""


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def atomic_record(path, data):
    """Exclusive durable marker, never overwrite crash evidence or an intent."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(path, flags, 0o600), 'w', encoding='utf-8') as output:
        json.dump(data, output, sort_keys=True)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    if os.name != 'nt':
        fd = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)


def validate_config(c):
    required = {'run_id', 'owner_id', 'evidence_root', 'expected_commit', 'source_bundle',
                'source_sha256', 'snapshot_id', 'vpc_id', 'ssh_key_id', 'ssh_key_fingerprint',
                'key_path', 'ssh_cidr', 'delete_authorized', 'region', 'size', 'max_hours',
                'max_usd', 'backups', 'ipv6', 'monitoring', 'dns', 'tool_sha256'}
    if type(c) is not dict or set(c) != required:
        raise ValueError('config_fields')
    if not watchdog.SLUG.fullmatch(c['run_id']) or not watchdog.OWNER.fullmatch(c['owner_id']):
        raise ValueError('run_or_owner')
    if (type(c['region']) is not str or type(c['size']) is not str
            or (c['region'], c['size']) not in AUTHORIZED_PLANS):
        raise ValueError('plan')
    if (type(c['max_hours']) is not int or c['max_hours'] != 4 or str(c['max_usd']) not in ('1', '1.0', '1.00')
            or c['delete_authorized'] is not True):
        raise ValueError('authorization')
    if any(c[k] is not False for k in ('backups', 'ipv6', 'monitoring')) or c['dns'] is not None:
        raise ValueError('additional_services')
    if (type(c['expected_commit']) is not str or not re.fullmatch(r'[0-9a-f]{40}', c['expected_commit'])
            or type(c['source_sha256']) is not str or not re.fullmatch(r'[0-9a-f]{64}', c['source_sha256'])
            or type(c['snapshot_id']) is not str or not re.fullmatch(r'[1-9][0-9]*', c['snapshot_id'])
            or type(c['vpc_id']) is not str or not watchdog.UUID.fullmatch(c['vpc_id'])
            or type(c['ssh_key_id']) is not int or c['ssh_key_id'] <= 0
            or type(c['ssh_key_fingerprint']) is not str
            or not re.fullmatch(r'(?:[0-9a-f]{2}:){15}[0-9a-f]{2}', c['ssh_key_fingerprint'])):
        raise ValueError('identity')
    if type(c['tool_sha256']) is not dict or set(c['tool_sha256']) != set(TOOLS) or any(
            type(value) is not str or not re.fullmatch(r'[0-9a-f]{64}', value)
            for value in c['tool_sha256'].values()):
        raise ValueError('tool_digest')
    root = watchdog.safe_path(c['evidence_root'])
    if root != FIXED_EVIDENCE_ROOT or root == REPO or REPO in root.parents or root == Path(root.anchor):
        raise ValueError('evidence_root')
    for field in ('source_bundle', 'key_path'):
        path = watchdog.safe_path(c[field])
        if path == REPO or REPO in path.parents or path == Path(path.anchor):
            raise ValueError(field)
    network = ipaddress.ip_network(c['ssh_cidr'], strict=True)
    if network.version != 4 or network.prefixlen != 32 or not network.is_global:
        raise ValueError('ssh_cidr')
    return dict(c)


def check_artifacts(c):
    root = watchdog.safe_path(c['evidence_root'])
    if not root.is_dir() or (os.name != 'nt' and stat.S_IMODE(root.stat().st_mode) & 0o077):
        raise Blocked('private_evidence_root_required')
    archive = watchdog.safe_path(c['source_bundle'])
    if not archive.is_file() or not 0 < archive.stat().st_size <= 512 * 1024 * 1024 + 1024 * 100000:
        raise Blocked('archive_missing_or_oversized')
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != c['source_sha256']:
        raise Blocked('archive_digest')
    for tool in TOOLS:
        if hashlib.sha256((BOOTSTRAP / tool).read_bytes()).hexdigest() != c['tool_sha256'][tool]:
            raise Blocked('tool_digest')
    return archive.stat().st_size


class OfficialAPI:
    """Finite endpoint/method allowlist; no redirects, bounded response and timeout."""
    def __init__(self, token):
        if type(token) is not str or not token: raise ValueError('token_required')
        self._token = token
        self._opener = urllib.request.build_opener(watchdog._NoRedirect)

    def request(self, method, path, payload=None):
        allowed = ((method == 'GET' and payload is None and GET_PATH.fullmatch(path))
                   or (method == 'POST' and path in POST_PATHS and type(payload) is dict)
                   or (method == 'DELETE' and payload is None and DELETE_PATH.fullmatch(path)))
        if not allowed: raise Blocked('api_allowlist')
        data = json.dumps(payload, separators=(',', ':')).encode() if payload is not None else None
        req = urllib.request.Request(BASE + path, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self._token, 'Accept': 'application/json',
            **({'Content-Type': 'application/json'} if data is not None else {})})
        try:
            with self._opener.open(req, timeout=10) as response:
                status = response.status
                raw = response.read(65537)
            if len(raw) > 65536 or status not in ((200, 404) if method == 'GET' else
                                                  (201, 202) if method == 'POST' else (204, 404)):
                raise Blocked('api_status_or_size')
            body = json.loads(raw) if raw else {}
            if type(body) is not dict: raise Blocked('api_body')
            return status, body
        except urllib.error.HTTPError as exc:
            exc.close()
            if method == 'GET' and exc.code == 404: return 404, {}
            if method == 'DELETE' and exc.code == 404: return 404, {}
            raise Blocked('api_http_status') from None
        except (OSError, ValueError) as exc:
            raise Blocked('api_unavailable') from None


def required_get(api, path, key):
    status, body = api.request('GET', path)
    if status != 200 or type(body.get(key)) is not dict: raise Blocked('missing_or_ambiguous_resource')
    return body[key]


def pages(api, kind):
    """Require exact totals and next URL, not a first-page approximation."""
    result, page, total = [], 1, None
    while page <= 100:
        path = f'/v2/{kind}?per_page=200&page={page}'
        status, body = api.request('GET', path)
        if status != 200 or type(body.get(kind)) is not list or type(body.get('meta')) is not dict:
            raise Blocked('inventory_incomplete')
        count = body['meta'].get('total')
        if type(count) is not int or count < 0 or (total is not None and total != count):
            raise Blocked('inventory_count')
        total = count
        result.extend(body[kind])
        links = body.get('links', {})
        if type(links) is not dict or type(links.get('pages', {})) is not dict:
            raise Blocked('inventory_links')
        nxt = links.get('pages', {}).get('next')
        if nxt is not None:
            if type(nxt) is not str: raise Blocked('inventory_next')
            parsed = urllib.parse.urlsplit(nxt)
            query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
            if (parsed.scheme != 'https' or parsed.netloc != 'api.digitalocean.com'
                    or parsed.path != '/v2/' + kind or parsed.fragment
                    or query != {'page': [str(page + 1)], 'per_page': ['200']}):
                raise Blocked('inventory_next')
        if nxt is None:
            if len(result) != total: raise Blocked('inventory_incomplete')
            return result
        if len(result) >= total: raise Blocked('inventory_overflow')
        page += 1
    raise Blocked('inventory_page_limit')


def require_empty_inventory(api):
    droplets = pages(api, 'droplets')
    for item in droplets:
        if type(item) is not dict or type(item.get('name')) is not str or type(item.get('tags')) is not list:
            raise Blocked('inventory_ambiguous')
        label = item['name'].lower()
        tags = item['tags']
        # There is no trustworthy production-vs-test classifier in a droplet name.
        # Fail closed on any Apollo identity rather than silently whitelisting one.
        if 'apollo' in label or any(type(tag) is not str or 'apollo' in tag.lower() for tag in tags):
            raise Blocked('existing_or_ambiguous_apollo_droplet')
    return len(droplets)


def preflight(api, c):
    require_empty_inventory(api)
    sizes = pages(api, 'sizes')
    selected = [s for s in sizes if type(s) is dict and s.get('slug') == c['size']]
    if len(selected) != 1: raise Blocked('size_not_unique')
    size = selected[0]
    try:
        rate = Decimal(str(size['price_hourly']))
    except (KeyError, ValueError, InvalidOperation):
        raise Blocked('price_unknown') from None
    if (not rate.is_finite() or rate <= 0 or rate * 4 > Decimal('1.00')
            or size.get('vcpus') != 8 or size.get('memory') != 16384
            or c['region'] not in size.get('regions', []) or size.get('available') is not True):
        raise Blocked('price_or_size_gate')
    snapshot = required_get(api, '/v2/snapshots/' + c['snapshot_id'], 'snapshot')
    if str(snapshot.get('id')) != c['snapshot_id']: raise Blocked('snapshot_identity')
    vpc = required_get(api, '/v2/vpcs/' + c['vpc_id'], 'vpc')
    if vpc.get('id') != c['vpc_id'] or vpc.get('region') != c['region']: raise Blocked('vpc_identity')
    key = required_get(api, '/v2/account/keys/' + str(c['ssh_key_id']), 'ssh_key')
    if (key.get('id') != c['ssh_key_id'] or key.get('fingerprint') != c['ssh_key_fingerprint']
            or type(key.get('public_key')) is not str):
        raise Blocked('ssh_key_identity')
    return key, str(rate)


def create_once(api, run_dir, run_id, kind, endpoint, payload):
    if kind not in ('tag', 'firewall', 'droplet') or endpoint != '/v2/' + ('firewalls' if kind == 'firewall' else kind + 's'):
        raise Blocked('create_allowlist')
    try:
        atomic_record(run_dir / ('create-' + kind + '.intent.json'), {
            'run_id': run_id, 'kind': kind, 'endpoint': endpoint,
            'payload_sha256': hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()})
    except FileExistsError:
        raise Blocked('create_intent_already_exists') from None
    status, body = api.request('POST', endpoint, payload)
    if status not in (201, 202) or type(body.get(kind)) is not dict:
        raise Blocked('create_response')
    return body[kind]


def journal(run_dir, status, **fields):
    """Append-only bounded nonsecret operator checkpoint outside the repository."""
    record = {'status': status, 'at_utc': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), **fields}
    data = (json.dumps(record, sort_keys=True) + '\n').encode()
    if len(data) > 4096: raise Blocked('journal_record_size')
    fd = os.open(run_dir / 'controller.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'ab') as file:
        file.write(data); file.flush(); os.fsync(file.fileno())

def safe_journal(run_dir, status, **fields):
    """Diagnostics are best effort and cannot replace a transport failure."""
    try:
        journal(run_dir, status, **fields)
    except Exception:
        pass


def host_key(run_dir):
    """Unique per-run ED25519 host key, pinned client-side; never a token."""
    from cryptography.hazmat.primitives.asymmetric import ed25519
    from cryptography.hazmat.primitives import serialization
    private = ed25519.Ed25519PrivateKey.generate()
    key = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                                serialization.NoEncryption())
    public = private.public_key().public_bytes(serialization.Encoding.OpenSSH,
                                                serialization.PublicFormat.OpenSSH).decode('ascii')
    path = run_dir / 'host_ed25519'
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
        file.write(key); file.flush(); os.fsync(file.fileno())
    return path, key.decode('ascii'), public


def cloud_init(private, public):
    if not private.endswith('\n') or not public.startswith('ssh-ed25519 '):
        raise Blocked('host_key_format')
    return ('#cloud-config\nssh_deletekeys: true\nssh_keys:\n  ed25519_private: |\n'
            + ''.join('    ' + line + '\n' for line in private.splitlines())
            + '  ed25519_public: ' + public + '\n')


def local_login_key(path, registered):
    import paramiko
    path = watchdog.safe_path(path)
    if not path.is_file(): raise Blocked('login_key_missing')
    try:
        key = paramiko.PKey.from_path(path)
    except Exception: raise Blocked('login_key_unreadable') from None
    fingerprint = ':'.join(f'{byte:02x}' for byte in key.get_fingerprint())
    if (fingerprint != registered['fingerprint'] or
            registered['public_key'].split()[:2] != [key.get_name(), key.get_base64()]):
        raise Blocked('login_key_mismatch')
    return key


def fresh_droplet(api, droplet_id, c, name, created_response):
    """Wait for a complete authorized readback, never relaxing a known mismatch."""
    expected = {'tags': [name], 'region': c['region'], 'size_slug': c['size'],
                'vpc_uuid': c['vpc_id'], 'image': 'ubuntu-24-04-x64'}

    def identity(value, source, complete):
        if type(value) is not dict:
            raise DropletReadbackBlocked('droplet_identity:' + source + '.body')
        for field, wanted in (('id', droplet_id), ('name', name)):
            if type(value.get(field)) is not type(wanted) or value[field] != wanted:
                raise DropletReadbackBlocked('droplet_identity:' + source + '.' + field)
        missing = []
        for field, wanted in expected.items():
            actual = value.get(field)
            if actual is None:
                missing.append(field)
                continue
            if field in ('region', 'image'):
                if type(actual) is not dict:
                    raise DropletReadbackBlocked('droplet_identity:' + source + '.' + field)
                # No proven contract makes a nested missing/blank slug provisional.
                actual = actual.get('slug')
                if actual is None:
                    raise DropletReadbackBlocked('droplet_identity:' + source + '.' + field)
            if type(actual) is not type(wanted) or actual != wanted:
                raise DropletReadbackBlocked('droplet_identity:' + source + '.' + field)
        created_at = value.get('created_at')
        if created_at is None:
            missing.append('created_at')
        else:
            try:
                if type(created_at) is not str or not created_at.endswith('Z'):
                    raise ValueError('timestamp')
                stamp(created_at)
            except (ValueError, OverflowError):
                raise DropletReadbackBlocked('droplet_identity:' + source + '.created_at') from None
        if complete and missing:
            raise DropletReadbackBlocked('droplet_identity_incomplete:' + ','.join(missing))
        return missing

    identity(created_response, 'post', False)
    if created_response.get('status') is not None and created_response['status'] not in ('new', 'active'):
        raise DropletReadbackBlocked('droplet_state:post')
    deadline = time.monotonic() + 600
    last_presence = 'state=not_found'
    while time.monotonic() < deadline:
        status, body = api.request('GET', '/v2/droplets/' + str(droplet_id))
        if status == 200:
            if type(body) is not dict: raise DropletReadbackBlocked('droplet_identity:readback.body')
            d = body.get('droplet')
            if type(d) is not dict: raise DropletReadbackBlocked('droplet_identity:readback.body')
            state = d.get('status')
            if state not in ('new', 'active'): raise DropletReadbackBlocked('droplet_state:readback')
            missing = identity(d, 'readback', state == 'active')
            last_presence = 'state=' + state + ';missing=' + (','.join(missing) if missing else 'none')
            if state == 'active':
                networks = d.get('networks')
                if networks is None:
                    addresses = []
                elif type(networks) is not dict:
                    raise DropletReadbackBlocked('public_ip:networks')
                else:
                    v4 = networks.get('v4')
                    if v4 is None:
                        addresses = []
                    elif type(v4) is not list:
                        raise DropletReadbackBlocked('public_ip:networks.v4')
                    else:
                        if any(type(n) is not dict for n in v4):
                            raise DropletReadbackBlocked('public_ip:networks.v4')
                        addresses = [n.get('ip_address') for n in v4 if n.get('type') == 'public']
                if len(addresses) > 1: raise DropletReadbackBlocked('public_ip:multiple')
                if len(addresses) == 1:
                    if addresses[0] is not None and addresses[0] != '':
                        try:
                            if type(addresses[0]) is not str: raise ValueError('ip')
                            ip = ipaddress.ip_address(addresses[0])
                        except ValueError:
                            raise DropletReadbackBlocked('public_ip:invalid') from None
                        if ip.version != 4 or not ip.is_global:
                            raise DropletReadbackBlocked('public_ip:invalid')
                        return d, str(ip)
                last_presence += ';public_ip=missing'
        elif status != 404: raise DropletReadbackBlocked('droplet_readback')
        time.sleep(min(5, max(0, deadline - time.monotonic())))
    raise DropletReadbackBlocked('droplet_readback_timeout:' + last_presence)


def ssh_ready(ip, deadline):
    """Bounded TCP readiness only before the first operational SSH handshake."""
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((ip, 22), timeout=3): return
        except OSError:
            time.sleep(5)
    raise Blocked('ssh_not_ready')


def open_pinned_ssh(ip, host_path, login_key):
    import paramiko
    client = paramiko.SSHClient()
    client.get_host_keys().add(ip, 'ssh-ed25519', paramiko.Ed25519Key.from_private_key_file(str(host_path)))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(ip, username='root', pkey=login_key, timeout=10,
                       banner_timeout=10, auth_timeout=10, channel_timeout=10,
                       allow_agent=False, look_for_keys=False)
        return client
    except Exception:
        client.close()
        raise Blocked('ssh_handshake_unknown') from None


def remote_write(sftp, path, source):
    try:
        sftp.lstat(path)
    except OSError as exc:
        if exc.errno != errno.ENOENT: raise
    else:
        raise Blocked('remote_path_exists')
    with sftp.open(path, 'wx') as output:
        if isinstance(source, bytes):
            output.write(source)
        else:
            with source.open('rb') as local:
                for chunk in iter(lambda: local.read(1024 * 1024), b''):
                    output.write(chunk)
        output.flush()
    sftp.chmod(path, 0o600)

def transfer_source(sftp, archive, root, expected_sha, run_dir, pump, deadline):
    """Bounded checkpoints on the original SFTP/guard transport, never a new owner."""
    started = time.monotonic()
    deadline = min(deadline, started + 1200)
    last_progress = started
    written = read = 0
    phase = 'upload'; operation = 'upload_open'
    safe_journal(run_dir, 'transfer_started', phase=phase, operation=operation,
                 duration_seconds=0, bytes_written=0, bytes_read=0)

    def checkpoint():
        nonlocal last_progress
        pump()
        now = time.monotonic()
        if now >= deadline: raise Blocked('guard_deadline_unknown')
        if now - last_progress >= 10:
            safe_journal(run_dir, 'transfer_progress', phase=phase, operation=operation,
                         duration_seconds=max(0, now - started), bytes_written=written, bytes_read=read)
            last_progress = now

    try:
        checkpoint()
        uploaded = root + '/source.tar'
        try: sftp.lstat(uploaded)
        except OSError as exc:
            if exc.errno != errno.ENOENT: raise
        else: raise Blocked('remote_path_exists')
        with sftp.open(uploaded, 'wx') as output, archive.open('rb') as local:
            operation = 'upload_write'
            while True:
                checkpoint()
                block = local.read(32768)
                if not block: break
                output.write(block)
                written += len(block)
                checkpoint()
            operation = 'upload_flush'
            output.flush()
        operation = 'upload_chmod'
        sftp.chmod(uploaded, 0o600)
        operation = 'upload_stat'
        checkpoint()
        info = sftp.lstat(uploaded)
        if not stat.S_ISREG(info.st_mode) or info.st_size != archive.stat().st_size:
            raise Blocked('upload_byte_count')
        phase = 'readback'; operation = 'readback_open'
        safe_journal(run_dir, 'transfer_phase', phase=phase, operation=operation,
                     duration_seconds=max(0, time.monotonic() - started), bytes_written=written, bytes_read=read)
        digest = hashlib.sha256()
        with sftp.open(uploaded, 'rb') as remote:
            operation = 'readback_read'
            while True:
                checkpoint()
                block = remote.read(32768)
                if not block: break
                read += len(block)
                if read > info.st_size: raise Blocked('upload_byte_count')
                digest.update(block)
                checkpoint()
        if read != info.st_size or digest.hexdigest() != expected_sha:
            raise Blocked('upload_readback_digest')
        phase = 'marker'; operation = 'marker_write'
        checkpoint()
        remote_write(sftp, root + '/upload.complete', (expected_sha + '\n').encode())
        safe_journal(run_dir, 'transfer_finished', phase=phase, operation=operation,
                     duration_seconds=max(0, time.monotonic() - started), bytes_written=written, bytes_read=read)
        return expected_sha
    except BaseException as exc:
        safe_journal(run_dir, 'transfer_failed', phase=phase, operation=operation,
                     callsite='transfer_source', error_type=type(exc).__name__,
                     duration_seconds=max(0, time.monotonic() - started),
                     bytes_written=written, bytes_read=read)
        raise


def read_sftp(sftp, path, max_bytes):
    info = sftp.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
        raise Blocked('remote_evidence_type_or_size')
    with sftp.open(path, 'rb') as file: data = file.read(max_bytes + 1)
    if len(data) > max_bytes or len(data) != info.st_size: raise Blocked('remote_evidence_short')
    return data


def owner_record(sftp, c, created_at):
    record = json.loads(read_sftp(sftp, '/run/lock/apollo-validation-owner.lock', 4096))
    if (type(record) is not dict or record.get('runId') != c['run_id']
            or type(record.get('pid')) is not int or record['pid'] <= 0
            or type(record.get('deadlineUTC')) is not str
            or stamp(record['deadlineUTC']) > stamp(created_at) + 10800 + 120):
        raise Blocked('owner_record_mismatch')
    return record


def remaining_guard_seconds(created_at_epoch):
    seconds = int(min(10800, created_at_epoch + 10800 - time.time() - 120))
    if not 300 <= seconds <= 10800:
        raise Blocked('guard_deadline')
    return seconds


def guard_session(ssh, sftp, c, droplet, archive, run_dir):
    """One SSH Transport: guard channel plus SFTP transfer on that same transport.

    Keep channel stdin open through exit and SFTP postflight; never send source tar to
    stdin: the actual remote_guard.upload contract is SFTP source.tar + marker.
    """
    transport = ssh.get_transport()
    if transport is None or not transport.is_active(): raise Blocked('transport_missing')
    tools_dir = '/opt/apollo-validation-tools-' + c['run_id']
    sftp.mkdir(tools_dir, 0o700)
    for tool in TOOLS:
        remote_write(sftp, tools_dir + '/' + tool, BOOTSTRAP / tool)
        if hashlib.sha256(read_sftp(sftp, tools_dir + '/' + tool, 1024 * 1024)).hexdigest() != c['tool_sha256'][tool]:
            raise Blocked('remote_tool_digest')
    root = '/opt/apollo-validation/' + c['run_id']
    try:
        sftp.mkdir('/opt/apollo-validation', 0o700)
    except IOError:
        base = sftp.lstat('/opt/apollo-validation')
        if not stat.S_ISDIR(base.st_mode) or base.st_mode & 0o077:
            raise Blocked('remote_base_identity') from None
    guard_c = dict(run_id=c['run_id'], owner_id=c['owner_id'], root=root,
                   expected_droplet_id=droplet['id'], expected_commit=c['expected_commit'],
                   source_sha256=c['source_sha256'],
                   duration_seconds=remaining_guard_seconds(stamp(droplet['created_at'])))
    remote_write(sftp, tools_dir + '/config.json', json.dumps(guard_c).encode())
    channel = transport.open_session(timeout=10)
    channel.settimeout(10)
    channel.exec_command('python3 ' + tools_dir + '/remote_guard.py ' + tools_dir + '/config.json')
    upload = False; lines = b''; owner = None; seen_result = False
    end = min(stamp(droplet['created_at']) + 10800 + 120, time.time() + guard_c['duration_seconds'] + 150)
    deadline = time.monotonic() + max(0, end - time.time())

    def pump_transfer():
        nonlocal lines
        if time.time() >= end or time.monotonic() >= deadline:
            raise Blocked('guard_deadline_unknown')
        if not transport.is_active(): raise Blocked('ssh_transport_lost')
        # Both channels belong to the one transport. Never persist raw stderr/stdout.
        for _ in range(4):
            if not channel.recv_stderr_ready(): break
            channel.recv_stderr(65536)
        for _ in range(4):
            if not channel.recv_ready(): break
            lines += channel.recv(65536)
            if len(lines) > 262144: raise Blocked('guard_line_limit')
        while b'\n' in lines:
            raw, lines = lines.split(b'\n', 1)
            try: event = json.loads(raw)
            except (ValueError, UnicodeDecodeError): raise Blocked('guard_event') from None
            if type(event) is not dict: raise Blocked('guard_event')
            if event.get('event') in ('result', 'upload_ready'):
                raise Blocked('guard_result_during_upload')
        if lines: raise Blocked('guard_event_incomplete_during_upload')
        if channel.exit_status_ready(): raise Blocked('guard_exit_during_upload')

    while time.time() < end:
        if not transport.is_active(): raise Blocked('ssh_transport_lost')
        if owner is None:
            try: owner = owner_record(sftp, c, droplet['created_at'])
            except (IOError, ValueError): pass  # lock may not yet have been written
        if channel.recv_ready():
            lines += channel.recv(65536)
            if len(lines) > 262144: raise Blocked('guard_line_limit')
            while b'\n' in lines:
                raw, lines = lines.split(b'\n', 1)
                try: event = json.loads(raw)
                except (ValueError, UnicodeDecodeError): raise Blocked('guard_event') from None
                if type(event) is not dict: raise Blocked('guard_event')
                if event.get('event') == 'upload_ready':
                    if upload or owner is None or event.get('run_id') != c['run_id'] or event.get('root') != root:
                        raise Blocked('upload_identity')
                    transfer_source(sftp, archive, root, c['source_sha256'], run_dir,
                                    pump_transfer, deadline)
                    upload = True
                elif event.get('event') == 'result':
                    seen_result = True
        if channel.recv_stderr_ready():
            channel.recv_stderr(65536)  # never archive unfiltered stderr or consume stdout
        if channel.exit_status_ready() and not channel.recv_ready():
            break
        time.sleep(.2)
    else:
        raise Blocked('guard_deadline_unknown')
    if not seen_result or owner is None: raise Blocked('guard_postflight_unobserved')
    exit_code = channel.recv_exit_status()
    if type(exit_code) is not int: raise Blocked('guard_exit_unknown')
    return owner, exit_code, upload


def finish_and_delete(c, run_dir, api, ssh, sftp, owner, exit_code, droplet, firewall, held):
    transport = ssh.get_transport()
    if transport is None or not transport.is_active():
        raise Blocked('ssh_loss_without_postflight')
    record, acceptance = collect_evidence(sftp, c, run_dir)
    m = manifest(c, run_dir, droplet, firewall, owner)
    verify_postflight(m, owner, exit_code)
    # Remote guard has exited; evidence is read over the original transport.
    sftp.close(); ssh.close()
    # Candidate is not persisted/claimed released until the consumer's complete
    # terminal proof (including real samples) passes after transport close.
    candidate = {**m, 'owner_released': True, 'ssh_timeout_unresolved': False,
                 'run_terminal_verified': True}
    watchdog.validate_manifest(candidate)
    if not watchdog.terminal_ready(candidate):
        raise Blocked('terminal_evidence_incomplete')
    m = candidate
    atomic_record(run_dir / 'manifest.json', m)
    if time.time() >= stamp(droplet['created_at']) + 4 * 3600:
        raise Blocked('four_hour_deadline')
    result = watchdog.run(m, api, mode='delete',
                          ownership_lock=lambda path: borrowed_lock(held, path))
    if result not in ('deleted_verified', 'already_deleted_verified'):
        raise Blocked('watchdog_' + result)
    return record, result, acceptance


PUBLIC_JSON = frozenset((
    'result.json', 'phase-gate-report-before-render.json', 'phase-gate-report.json',
    'phase-gate-history-api.json', 'synthetic-phase-gate-history-browser.json',
    'transformation-critic-read.json', 'transformation-critic-report-viewer-browser.json',
    'project-a-final-render-identity.json', 'project-b-final-render-identity.json',
    'project-a-final-render-terminal.json', 'project-b-final-render-terminal.json',
))
EXPECTED_SUCCESS = frozenset((
    'result.json', 'synthetic-phase-gate.png', 'synthetic-phase-gate-history-browser.json',
    'transformation-critic-report-viewer-browser.json',
    'project-a-final.mp4', 'project-b-final.mp4',
    'project-a-final-render-identity.json', 'project-b-final-render-identity.json',
    'project-a-final-render-terminal.json', 'project-b-final-render-terminal.json',
))
SECRET_FIELD = re.compile(r'senha|password|token|authorization|cookie|secret', re.I)

def sanitize_public(value):
    if type(value) is dict:
        return {key: '[REDACTED]' if SECRET_FIELD.search(key) else sanitize_public(item)
                for key, item in value.items()}
    if type(value) is list:
        return [sanitize_public(item) for item in value]
    return value

MONITOR_PROBES = frozenset(('docker.inspect.pg', 'docker.exec.pg_activity',
                            'docker.inspect.runner', 'docker.top.runner',
                            'docker.probe_exit_code.runner'))
MONITOR_STAGES = frozenset(('preflight', 'continuous', 'pg_admission',
                            'cleanup_between_stops', 'postflight'))
MAX_MONITOR_EVENTS = 2000 * 12  # sequence cap * sample start/end plus five probe start/end pairs

def monitor_diagnostics(raw):
    """Allowlist only typed monitor fields; never copy a remote string or argv."""
    if not raw or not raw.endswith(b'\n'):
        raise Blocked('monitor_diagnostics_incomplete')
    rows = []
    try:
        for line in raw.splitlines():
            row = json.loads(line)
            kind = row['kind']; outcome = row['outcome']
            if (type(row) is not dict or kind not in ('sample', 'probe')
                    or row['stage'] not in MONITOR_STAGES
                    or type(row['sequence']) is not int or not 1 <= row['sequence'] <= 2000
                    or outcome not in ({'started', 'completed', 'failed'} if kind == 'sample'
                                       else {'started', 'completed', 'timeout', 'aborted', 'failed'})
                    or any(type(row[key]) not in (int, float) or not math.isfinite(row[key])
                           or row[key] < 0 for key in ('monotonic_at', 'duration_seconds'))):
                raise ValueError('shape')
            safe = {key: row[key] for key in ('kind', 'sequence', 'stage', 'monotonic_at',
                                               'duration_seconds', 'outcome')}
            if kind == 'probe':
                if (row['probe'] not in MONITOR_PROBES or type(row['timeout_seconds']) not in (int, float)
                        or not math.isfinite(row['timeout_seconds']) or not 0 < row['timeout_seconds'] <= 8
                        or row['terminated'] is not None and type(row['terminated']) is not bool
                        or row['return_code'] is not None and type(row['return_code']) is not int):
                    raise ValueError('probe')
                safe.update({key: row[key] for key in ('probe', 'timeout_seconds', 'terminated', 'return_code')})
            rows.append(safe)
            if len(rows) > MAX_MONITOR_EVENTS: raise ValueError('count')
    except (KeyError, TypeError, ValueError, UnicodeDecodeError):
        raise Blocked('monitor_diagnostics_invalid') from None
    if not rows: raise Blocked('monitor_diagnostics_incomplete')
    return ''.join(json.dumps(row, sort_keys=True)+'\n' for row in rows).encode()

def sanitized_samples(raw):
    """Preserve numeric readings and known operational states, never arbitrary remote text."""
    if not raw or not raw.endswith(b'\n'):
        raise Blocked('samples_incomplete')
    rows = []
    numeric = ('at', 'monotonic_at', 'busy', 'steal', 'iowait', 'load1', 'load_ratio')
    integers = ('ncpu', 'available_kib', 'oom_delta')
    try:
        for line in raw.splitlines():
            row = json.loads(line)
            if (type(row) is not dict or row['stage'] not in MONITOR_STAGES
                    or any(type(row[k]) not in (float, int) or not math.isfinite(row[k]) or row[k] < 0 for k in numeric)
                    or any(type(row[k]) is not int or row[k] < 0 for k in integers)
                    or row['reason'] is not None and (type(row['reason']) is not str or
                        not re.fullmatch('[a-z_]{1,40}', row['reason']))):
                raise ValueError('sample')
            pg, app = row['pg'], row['app']
            if type(pg) is str and pg != 'N/A (not started)': raise ValueError('pg')
            if type(app) is str and app != 'N/A (not started)': raise ValueError('app')
            if type(pg) is dict:
                if set(pg) == {'state', 'orphan_backends'}:
                    if pg != {'state':'stopped', 'orphan_backends':'N/A (see cleanup verification)'}: raise ValueError('pg')
                elif set(pg) != {'total', 'max_connections', 'ours', 'strangers'} or any(type(v) is not int or v < 0 for v in pg.values()):
                    raise ValueError('pg')
            elif type(pg) is not str: raise ValueError('pg')
            if type(app) is dict:
                if set(app) == {'port', 'status', 'latency_seconds'}:
                    if (type(app['port']) is not int or not 1 <= app['port'] <= 65535
                            or app['status'] is not None and type(app['status']) is not int
                            or type(app['latency_seconds']) not in (int, float)
                            or not math.isfinite(app['latency_seconds']) or app['latency_seconds'] < 0): raise ValueError('app')
                elif set(app) == {'state', 'runner_exit', 'last_port'}:
                    if app['state'] != 'expected_teardown' or type(app['runner_exit']) is not str or not re.fullmatch('[0-9]{1,3}',app['runner_exit']) or app['last_port'] is not None and type(app['last_port']) is not int: raise ValueError('app')
                elif set(app) == {'state', 'last_port'}:
                    if app['state'] != 'expected_teardown' or app['last_port'] is not None and type(app['last_port']) is not int: raise ValueError('app')
                elif app not in ({'state':'created_not_started'}, {'state':'stopped', 'runner_exit':0}): raise ValueError('app')
            elif type(app) is not str: raise ValueError('app')
            safe = {k: row[k] for k in (*numeric, *integers, 'stage', 'reason', 'pg', 'app')}
            rows.append(safe)
            if len(rows) > 2000: raise ValueError('count')
    except (KeyError, TypeError, ValueError, UnicodeDecodeError):
        raise Blocked('samples_invalid') from None
    return ''.join(json.dumps(row, sort_keys=True)+'\n' for row in rows).encode()

def collect_evidence(sftp, c, run_dir):
    """Safety proof is mandatory; editorial readback errors never authorize deletion."""
    root = '/opt/apollo-validation/' + c['run_id'] + '/evidence/'
    atomic_bytes(run_dir / 'postflight.json', read_sftp(sftp, root + 'postflight.json', 131072))
    diagnostic = read_sftp(sftp, root + 'monitor-diagnostics.jsonl', 4 * 1024 * 1024)
    atomic_bytes(run_dir / 'monitor-diagnostics.jsonl', monitor_diagnostics(diagnostic))
    samples = read_sftp(sftp, root + 'samples.jsonl', 2 * 1024 * 1024)
    atomic_bytes(run_dir / 'samples.jsonl', sanitized_samples(samples))
    record = watchdog.read_record(str(run_dir / 'postflight.json'))
    errors = []
    try:
        atomic_bytes(run_dir / 'batch-results.jsonl', read_sftp(sftp, root + 'batch-results.jsonl', 131072))
    except IOError:
        pass  # before-run failure may have no batch; never manufacture a phase
    except (Blocked, ValueError, OSError):
        errors.append('batch_results_readback')
    visual = root + 'journey/' + c['run_id']
    try: files = sftp.listdir_attr(visual)
    except IOError:
        files = []
        errors.append('visual_directory_unavailable')
    total = 0; collected = []; render_checks = []; metadata = {}
    for info in files:
        name = info.filename
        if name not in PUBLIC_JSON and not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}\.(?:png|jpg|jpeg|webp|mp4)', name, re.I):
            continue
        try:
            limit = 65536 if name in PUBLIC_JSON else 200 * 1024 * 1024
            if not stat.S_ISREG(info.st_mode) or not 0 <= info.st_size <= limit:
                raise Blocked('visual_evidence_size')
            total += info.st_size
            if total > 512 * 1024 * 1024: raise Blocked('visual_evidence_budget')
            content = read_sftp(sftp, visual + '/' + name, limit)
            suffix = Path(name).suffix.lower()
            if name in PUBLIC_JSON:
                obj = json.loads(content)
                if type(obj) is not dict: raise Blocked('visual_json_object')
                metadata[name] = obj
                content = (json.dumps(sanitize_public(obj), ensure_ascii=False, sort_keys=True) + '\n').encode()
            elif suffix == '.mp4':
                if len(content) < 12 or content[4:8] != b'ftyp': raise Blocked('visual_mp4_header')
                identity_name = name[:-4] + '-render-identity.json'
                if identity_name not in PUBLIC_JSON: raise Blocked('visual_render_identity')
                identity = json.loads(read_sftp(sftp, visual + '/' + identity_name, 65536))
                terminal_name = name[:-4] + '-render-terminal.json'
                if terminal_name not in PUBLIC_JSON: raise Blocked('visual_render_identity')
                terminal = json.loads(read_sftp(sftp, visual + '/' + terminal_name, 65536))
                digest = identity.get('outputSha256') if type(identity) is dict else None
                if (type(digest) is not str or not re.fullmatch(r'[0-9a-f]{64}', digest)
                        or hashlib.sha256(content).hexdigest() != digest or type(terminal) is not dict):
                    raise Blocked('visual_render_identity')
                operation = terminal.get('operation')
                checkpoint = terminal.get('checkpoint')
                quality = terminal.get('qualityReport')
                attestation = terminal.get('attestation')
                fields = ('workspaceId', 'projectId', 'projectVersionId', 'productionRunId',
                          'publicOperationId', 'outputArtifactId', 'outputManifestId', 'outputSha256')
                if (type(operation) is not dict or type(checkpoint) is not dict
                        or type(quality) is not dict or type(attestation) is not dict):
                    raise Blocked('visual_render_identity')
                attested_identity = attestation.get('identity')
                if type(attested_identity) is not dict:
                    raise Blocked('visual_render_identity')
                if (any(type(identity.get(key)) is not str or not identity[key].strip()
                               or quality.get(key) != identity[key] for key in fields)
                        or operation.get('id') != identity['publicOperationId']
                        or operation.get('status') != 'succeeded'
                        or checkpoint.get('outputSha256') != digest
                        or type(identity.get('attempt')) is not int or identity['attempt'] < 1
                        or type(checkpoint.get('attempt')) is not int
                        or checkpoint['attempt'] != identity['attempt']
                        or quality.get('passed') is not True
                        or attested_identity.get('commitSha') != c['expected_commit']):
                    raise Blocked('visual_render_identity')
                render_checks.append({'file': name, 'sha256': digest,
                                      'production_run_id': identity['productionRunId']})
            elif suffix == '.png' and not content.startswith(b'\x89PNG\r\n\x1a\n'):
                raise Blocked('visual_png_header')
            elif suffix in ('.jpg', '.jpeg') and not content.startswith(b'\xff\xd8'):
                raise Blocked('visual_jpeg_header')
            elif suffix == '.webp' and not (content.startswith(b'RIFF') and content[8:12] == b'WEBP'):
                raise Blocked('visual_webp_header')
            atomic_bytes(run_dir / ('visual-' + name), content)
            collected.append(name)
        except (Blocked, IOError, ValueError, UnicodeDecodeError, TypeError, OSError) as exc:
            errors.append(str(exc) if isinstance(exc, Blocked) else 'visual_readback_' + name)
    # A screenshot alone does not prove the W27 browser's real assertions ran.
    for name in ('synthetic-phase-gate-history-browser.json', 'transformation-critic-report-viewer-browser.json'):
        if name in metadata and (metadata[name].get('failed') is True or not metadata[name].get('real')):
            errors.append('browser_real_evidence_' + name)
    if 'result.json' in metadata and metadata['result.json'].get('runId') != c['run_id']:
        errors.append('visual_run_identity')
    missing = sorted(EXPECTED_SUCCESS - set(collected)) if record.get('work_outcome') == 'success' else []
    acceptance = {'status': 'failed' if errors or missing or record.get('work_outcome') != 'success' else 'passed',
                  'missing': missing, 'errors': errors}
    atomic_record(run_dir / 'visual-inventory.json', {'collected': sorted(collected),
                  'renders': render_checks, 'acceptance': acceptance})
    return record, acceptance


def atomic_bytes(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
        output.write(data); output.flush(); os.fsync(output.fileno())


@contextmanager
def borrowed_lock(held, path):
    """Nested watchdog.run uses this *same* owner lease, without unlocking it."""
    if not held['active'] or path != held['path']:
        raise watchdog.OwnerActive
    yield
    if not held['active']: raise watchdog.OwnerActive


def manifest(c, run_dir, droplet, firewall, owner):
    name = NAME_PREFIX + c['run_id']
    return dict(run_id=c['run_id'], owner_id=c['owner_id'], environment='disposable-validation',
                scope='apollo-validation', owner_pid=owner['pid'], owner_deadline_utc=owner['deadlineUTC'],
                expected_commit=c['expected_commit'], droplet_id=droplet['id'], droplet_name=name,
                firewall_id=firewall['id'], firewall_name=name, tag=name, region=c['region'], size=c['size'],
                vpc_id=c['vpc_id'], snapshot_id=c['snapshot_id'], created_at=droplet['created_at'],
                not_before=int(stamp(droplet['created_at'])), delete_authorized=True,
                run_terminal_verified=False, owner_released=False, incident_active=False,
                ssh_timeout_unresolved=True, evidence_root=c['evidence_root'],
                lockfile=str(Path(c['evidence_root']) / 'apollo-validation-owner.lock'),
                postflight_file=str(run_dir / 'postflight.json'), prework_file=str(run_dir / 'prework.json'))


def verify_postflight(m, owner, exit_code):
    record = watchdog.read_record(m['postflight_file'])
    bound = dict(run_id=m['run_id'], owner_id=m['owner_id'], expected_droplet_id=m['droplet_id'],
                 source_commit=m['expected_commit'], owner_pid=owner['pid'],
                 owner_deadline_utc=owner['deadlineUTC'])
    if (type(record) is not dict or any(type(record.get(k)) is not type(v) or record.get(k) != v
                                        for k, v in bound.items())
            or type(record.get('exit_code')) is not int or record['exit_code'] != exit_code):
        raise Blocked('postflight_binding')
    return record


def execute(c, loader):
    """Single owner/process: no resume after crash and no mutation on unknown state."""
    size = check_artifacts(c)
    run_dir = Path(c['evidence_root']) / c['run_id']
    with watchdog.claim_lock(str(Path(c['evidence_root']) / 'apollo-validation-owner.lock')):
        if run_dir.exists(): raise Blocked('existing_run_requires_owner_review')
        run_dir.mkdir(mode=0o700)
        held = {'active': True, 'path': str(Path(c['evidence_root']) / 'apollo-validation-owner.lock')}
        state = {'run_id': c['run_id'], 'owner_id': c['owner_id'], 'controller_pid': os.getpid(),
                 'status': 'started', 'source_bytes': size}
        atomic_record(run_dir / 'start.json', state)
        api = None; ssh = None; sftp = None
        journal(run_dir, 'started', controller_pid=os.getpid())
        phase = 'loader'; started_at = time.monotonic()
        try:
            token = loader.load_token()
            api = OfficialAPI(token)
            del token
            phase = 'preflight'
            registered, rate = preflight(api, c)
            state['hourly_usd'] = rate
            journal(run_dir, 'inventory_verified', hourly_usd=rate)
            login_key = local_login_key(c['key_path'], registered)
            host_path, host_private, host_public = host_key(run_dir)
            cloud = cloud_init(host_private, host_public)
            del host_private
            name = NAME_PREFIX + c['run_id']
            phase = 'tag_create'
            tag = create_once(api, run_dir, c['run_id'], 'tag', '/v2/tags', {'name': name})
            tag_read = required_get(api, '/v2/tags/' + name, 'tag')
            if tag.get('name') != name or tag_read.get('name') != name:
                raise Blocked('tag_readback')
            journal(run_dir, 'tag_verified', name=name)
            phase = 'firewall_create'
            firewall = create_once(api, run_dir, c['run_id'], 'firewall', '/v2/firewalls', {
                'name': name, 'tags': [name], 'droplet_ids': [],
                'inbound_rules': [{'protocol': 'tcp', 'ports': '22',
                                   'sources': {'addresses': [c['ssh_cidr']]}}],
                'outbound_rules': [{'protocol': 'tcp', 'ports': 'all',
                                    'destinations': {'addresses': ['0.0.0.0/0']}},
                                   {'protocol': 'udp', 'ports': 'all',
                                    'destinations': {'addresses': ['0.0.0.0/0']}}]})
            firewall_id = firewall.get('id')
            if type(firewall_id) is not str or not watchdog.UUID.fullmatch(firewall_id):
                raise Blocked('firewall_id_unknown')
            read_fw = required_get(api, '/v2/firewalls/' + firewall_id, 'firewall')
            if not watchdog.matches_firewall(read_fw, {'firewall_id': firewall_id,
                   'firewall_name': name, 'tag': name, 'droplet_id': -1}):
                raise Blocked('firewall_readback')
            journal(run_dir, 'firewall_verified', firewall_id=firewall_id)
            phase = 'droplet_create'
            response = create_once(api, run_dir, c['run_id'], 'droplet', '/v2/droplets', {
                'name': name, 'region': c['region'], 'size': c['size'], 'image': 'ubuntu-24-04-x64',
                'ssh_keys': [c['ssh_key_id']], 'backups': False, 'ipv6': False,
                'monitoring': False, 'tags': [name], 'vpc_uuid': c['vpc_id'],
                'user_data': cloud})
            del cloud
            droplet_id = response.get('id')
            if type(droplet_id) is not int or droplet_id <= 0:
                raise Blocked('droplet_identity_unknown')
            phase = 'droplet_readback'
            droplet, ip = fresh_droplet(api, droplet_id, c, name, response)
            journal(run_dir, 'droplet_verified', droplet_id=droplet_id,
                    created_at=droplet['created_at'])
            if time.time() >= stamp(droplet['created_at']) + 10800 - 2700:
                raise Blocked('cleanup_reserve_elapsed')
            remaining_guard_seconds(stamp(droplet['created_at']))
            phase = 'setup_ssh'
            ssh_ready(ip, time.monotonic() + 600)
            ssh = open_pinned_ssh(ip, host_path, login_key)
            sftp = ssh.open_sftp()
            sftp.get_channel().settimeout(10)
            journal(run_dir, 'ssh_pinned', droplet_id=droplet_id)
            phase = 'guard'
            owner, exit_code, uploaded = guard_session(ssh, sftp, c, droplet,
                                                       Path(c['source_bundle']), run_dir)
            journal(run_dir, 'guard_exited', guard_exit=exit_code,
                    owner_pid=owner['pid'], owner_deadline_utc=owner['deadlineUTC'])
            phase = 'collect_and_cleanup'
            record, result, acceptance = finish_and_delete(c, run_dir, api, ssh, sftp, owner,
                                               exit_code, droplet, firewall, held)
            sftp = None; ssh = None
            state.update(status='deleted_verified', cleanup_outcome=result,
                         work_outcome=record.get('work_outcome', 'unknown'),
                         acceptance=acceptance, guard_exit=exit_code, uploaded=uploaded,
                         snapshot_id=c['snapshot_id'])
            atomic_record(run_dir / 'result.json', state)
            journal(run_dir, result, work_outcome=state['work_outcome'], acceptance=acceptance['status'])
            return state
        except BaseException as exc:
            safe_journal(run_dir, 'needs_owner_intervention', phase=phase, callsite='execute',
                         duration_seconds=max(0, time.monotonic() - started_at),
                         error_type=type(exc).__name__,
                         **({'readback_check': str(exc)} if isinstance(exc, DropletReadbackBlocked) else {}))
            raise
        finally:
            if sftp is not None: sftp.close()
            if ssh is not None: ssh.close()
            held['active'] = False
            # No on-error DELETE or second SSH. Existing intents/evidence remain for owner.


def load_private_loader(path):
    path = watchdog.safe_path(path)
    if path == REPO or REPO in path.parents or not path.is_file():
        raise Blocked('private_loader_required')
    spec = importlib.util.spec_from_file_location('approved_local_do_token_loader', path)
    if spec is None or spec.loader is None: raise Blocked('loader_invalid')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, 'load_token', None)):
        raise Blocked('loader_contract')
    return module


def main(argv=None):
    parser = argparse.ArgumentParser(description='One-shot disposable DO validation controller')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--execute', action='store_true')
    parser.add_argument('--config', required=True)
    parser.add_argument('--token-loader', help='absolute private Python file with load_token(); execute only')
    args = parser.parse_args(argv)
    try:
        c = validate_config(watchdog.read_record(str(watchdog.safe_path(args.config))))
        size = check_artifacts(c)
        if args.check:
            if args.token_loader: raise Blocked('loader_only_on_execute')
            status = {'status': 'offline_valid', 'run_id': c['run_id'], 'source_bytes': size}
        else:
            if not args.token_loader: raise Blocked('token_loader_required')
            status = execute(c, load_private_loader(args.token_loader))
        print(json.dumps(status, sort_keys=True))
        return 1 if args.execute and (status['work_outcome'] != 'success' or status['acceptance']['status'] != 'passed') else 0
    except Exception as exc:
        # Fixed status only: never echo HTTP errors, key contents, loader or token.
        print(json.dumps({'status': 'needs_owner_intervention' if args.execute else 'offline_blocked',
                          'reason': str(exc) if isinstance(exc, Blocked) else type(exc).__name__}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
