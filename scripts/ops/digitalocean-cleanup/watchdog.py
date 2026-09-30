"""Opt-in, single-run DigitalOcean cleanup. Local evidence is operator-controlled,
not cryptographic proof of remote termination. Never run without an exclusive owner.

Operator handoff: copy the guard's evidence/postflight.json and samples.jsonl
unchanged into a private evidence_root/<run_id>/ beside each other; separately
verify owner release, process terminality and resource identity. A failed E2E
does not prove cleanup failed; a never-dispatched PG is not zero backends.
Missing or inconclusive evidence blocks deletion. Check-only is local.
"""
import argparse
import contextlib
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import urllib.error
import urllib.request


class OwnerActive(Exception):
    pass


class ApiFailure(Exception):
    pass


UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z')
SLUG = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,27}[a-z0-9])?\Z')
OWNER = re.compile(r'[a-zA-Z0-9_-]{1,64}\Z')
STAMP = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\Z')
TERMINAL_STATES = {'exited', 'stopped', 'removed'}
REPO = Path(__file__).resolve().parents[3]


def utc_stamp(value):
    if type(value) is not str or not STAMP.fullmatch(value):
        raise ValueError('timestamp')
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def safe_path(value):
    """Validate lexical path and all existing ancestors; never resolve an alias."""
    if type(value) is not str or not os.path.isabs(value) or not value:
        raise ValueError('path')
    path = Path(value)
    if os.path.normpath(value) != value or any(p in ('.', '..') for p in path.parts):
        raise ValueError('path')
    for candidate in (path, *path.parents):
        if candidate.is_symlink() or (hasattr(candidate, 'is_junction') and candidate.is_junction()):
            raise ValueError('symlink')
    return path


def validate_manifest(m):
    """No token is read here. Do not normalize malformed identifiers."""
    try:
        if type(m) is not dict:
            raise ValueError
        run_id, owner = m['run_id'], m['owner_id']
        if type(run_id) is not str or not SLUG.fullmatch(run_id):
            raise ValueError
        if type(owner) is not str or not OWNER.fullmatch(owner):
            raise ValueError
        if m.get('environment') != 'disposable-validation' or m.get('scope') != 'apollo-validation':
            raise ValueError
        name = 'apollo-validation-' + run_id
        if any(m.get(k) != name for k in ('droplet_name', 'firewall_name', 'tag')):
            raise ValueError
        if type(m.get('droplet_id')) is not int or m['droplet_id'] <= 0:
            raise ValueError
        if any(type(m.get(k)) is not str or not UUID.fullmatch(m[k]) for k in ('vpc_id', 'firewall_id')):
            raise ValueError
        if type(m.get('snapshot_id')) is not str or not re.fullmatch(r'[1-9][0-9]*', m['snapshot_id']):
            raise ValueError
        if type(m.get('region')) is not str or not re.fullmatch(r'[a-z]{2,5}[0-9]{1,2}', m['region']):
            raise ValueError
        if type(m.get('size')) is not str or not re.fullmatch(r'[a-z][a-z0-9-]{2,63}', m['size']):
            raise ValueError
        if type(m.get('expected_commit')) is not str or not re.fullmatch(r'[0-9a-f]{40}', m['expected_commit']):
            raise ValueError
        if type(m.get('owner_pid')) is not int or m['owner_pid'] <= 0:
            raise ValueError
        created = utc_stamp(m['created_at'])
        deadline = utc_stamp(m['owner_deadline_utc'])
        if (type(m.get('not_before')) is not int or m['not_before'] < created.timestamp()
                or deadline <= created or m['not_before'] > deadline.timestamp()):
            raise ValueError
        if any(type(m.get(k)) is not bool for k in
               ('delete_authorized', 'run_terminal_verified', 'owner_released',
                'incident_active', 'ssh_timeout_unresolved')):
            raise ValueError
        root = safe_path(m['evidence_root'])
        if root == REPO or REPO in root.parents or root == Path(root.anchor):
            raise ValueError
        if not root.is_dir() or (os.name != 'nt' and stat.S_IMODE(root.stat().st_mode) & 0o077):
            raise ValueError
        run_dir = root / run_id
        if safe_path(m['lockfile']) != root / 'apollo-validation-owner.lock':
            raise ValueError
        if safe_path(m['postflight_file']) != run_dir / 'postflight.json':
            raise ValueError
        if safe_path(m['prework_file']) != run_dir / 'prework.json':
            raise ValueError
        safe_path(str(run_dir))
        return dict(m)
    except (KeyError, TypeError, ValueError, OSError, OverflowError):
        raise ValueError('invalid_manifest') from None


@contextlib.contextmanager
def claim_lock(path):
    """Global nonblocking OS lock. Never unlink: replacement inodes defeat locks."""
    safe_path(path)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, 'r+b') as file:
        if os.name == 'nt':
            import msvcrt
            try:
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise OwnerActive from None
            try:
                yield
            finally:
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise OwnerActive from None
            try:
                yield
            finally:
                fcntl.flock(file, fcntl.LOCK_UN)


def read_record(path):
    safe_path(path)
    with open(path, 'rb') as source:
        data = source.read(131073)
    if len(data) > 131072:
        raise ValueError('oversized_record')
    return json.loads(data)

def valid_windows(windows):
    if type(windows) is not dict or set(windows) != {'preflight', 'postflight'}:
        return False
    for stage, minimum in (('preflight', 300), ('postflight', 60)):
        window = windows[stage]
        if type(window) is not dict or set(window) != {'started', 'finished'}:
            return False
        start, end = window['started'], window['finished']
        if (type(start) is not float or type(end) is not float
                or not math.isfinite(start) or not math.isfinite(end)
                or end - start < minimum):
            return False
    return windows['preflight']['finished'] <= windows['postflight']['started']

def valid_samples(path, count, windows):
    if type(count) is not int or count < 36:
        return False
    if not valid_windows(windows):
        return False
    safe_path(str(path))
    if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
        return False
    with path.open('rb') as source:
        raw = source.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        return False
    if not raw.endswith(b'\n'):
        return False
    lines = raw.splitlines()
    if len(lines) != count:
        return False
    stages = {'preflight': [], 'postflight': []}
    previous = None
    for line in lines:
        sample = json.loads(line)
        if type(sample) is not dict or sample.get('reason') is not None:
            return False
        stage = sample.get('stage')
        if type(stage) is not str or not stage:
            return False
        tick = sample.get('monotonic_at')
        if type(tick) is not float or not math.isfinite(tick):
            return False
        if previous is not None and tick <= previous:
            return False
        previous = tick
        if stage in stages:
            window = windows[stage]
            if not window['started'] <= tick <= window['finished']:
                return False
            stages[stage].append(tick)
        for key in ('at', 'busy', 'steal', 'iowait', 'load1', 'load_ratio'):
            value = sample.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                return False
            if not math.isfinite(value) or value < 0:
                return False
        if sample['busy'] > 100 or sample['steal'] > 100 or sample['iowait'] > 100:
            return False
        for key in ('ncpu', 'available_kib', 'oom_delta'):
            value = sample.get(key)
            if type(value) is not int or value < (1 if key == 'ncpu' else 0):
                return False
        if type(sample.get('pg')) not in (str, dict) or type(sample.get('app')) not in (str, dict):
            return False
    for stage, ticks in stages.items():
        window = windows[stage]
        if (len(ticks) < (30 if stage == 'preflight' else 6)
                or ticks[0] - window['started'] > 11
                or window['finished'] - ticks[-1] > 11
                or any(b - a > 11 for a, b in zip(ticks, ticks[1:]))):
            return False
    return True


def valid_terminal_record(record):
    """Work outcome is independent of verified terminal cleanup; contradictions fail closed."""
    if type(record.get('exit_code')) is not int or type(record.get('phases')) is not list:
        return False
    phases = record['phases']
    if any(type(p) is not dict or type(p.get('phase')) is not str or
           type(p.get('exit_code')) is not int for p in phases):
        return False
    work = record.get('work_errors')
    cleanup = record.get('cleanup_errors')
    if (type(work) is not list or type(cleanup) is not list or
            any(type(item) is not str or not item for item in work + cleanup)
            or cleanup or record.get('errors') != work + cleanup or
            record.get('error') != (work[0] if len(work) == 1 else None) or
            record.get('cleanup_ok') is not True or record.get('cleanup_outcome') != 'verified'):
        return False
    outcome = record.get('work_outcome')
    if outcome == 'success':
        if (record['exit_code'] != 0 or work or any(p['exit_code'] != 0 for p in phases)
                or not any(p['phase'] == 'runner' for p in phases)
                or not phases or phases[-1]['phase'] != 'runner_exit'):
            return False
    elif outcome == 'failed':
        if record['exit_code'] == 0 or not work:
            return False
    else:
        return False
    evidence = record.get('terminal_evidence')
    if type(evidence) is not dict or set(evidence) != {
            'root_owned', 'root_identity', 'runner', 'pg', 'backend_proof'}:
        return False
    identity = evidence['root_identity']
    if (evidence['root_owned'] is not True or type(identity) is not list or len(identity) != 2
            or any(type(number) is not int or number < 0 for number in identity)
            or type(record.get('container_states')) is not dict):
        return False
    states = record['container_states']
    if set(states) != {'runner', 'pg'}:
        return False
    for kind, phase in (('runner', 'runner_create'), ('pg', 'pg_start')):
        part = evidence[kind]
        if type(part) is not dict or set(part) != {'creation', 'terminal'} or part['terminal'] != states[kind]:
            return False
        if part['creation'] == 'not_dispatched_verified':
            if states[kind] != 'never_started' or any(p['phase'] == phase for p in phases):
                return False
        elif part['creation'] == 'created_verified':
            dispatches = [p for p in phases if p['phase'] == phase]
            if (states[kind] not in TERMINAL_STATES or len(dispatches) != 1
                    or dispatches[0]['exit_code'] != 0):
                return False
        else:
            return False
    if evidence['runner']['creation'] == 'created_verified' and evidence['pg']['creation'] != 'created_verified':
        return False
    if evidence['pg']['creation'] == 'not_dispatched_verified':
        if record.get('orphan_backends') != 'N/A' or evidence['backend_proof'] != 'not_applicable_no_pg_created':
            return False
    elif (type(record.get('orphan_backends')) is not int or record['orphan_backends'] != 0
          or evidence['backend_proof'] != 'observed_zero'):
        return False
    return True

def terminal_ready(m):
    if (m['owner_released'] is not True or m['incident_active'] is not False
            or m['ssh_timeout_unresolved'] is not False or m['run_terminal_verified'] is not True):
        return False
    try:
        record = read_record(m['postflight_file'])
        bound = {'run_id': m['run_id'], 'owner_id': m['owner_id'],
                 'expected_droplet_id': m['droplet_id'], 'source_commit': m['expected_commit'],
                 'owner_pid': m['owner_pid'], 'owner_deadline_utc': m['owner_deadline_utc']}
        return (type(record) is dict
                and all(type(record.get(key)) is type(value) and record[key] == value
                        for key, value in bound.items())
                and valid_terminal_record(record)
                and valid_samples(Path(m['postflight_file']).parent / 'samples.jsonl',
                                  record.get('samples'), record.get('windows')))
    except (OSError, ValueError, TypeError, KeyError):
        return False


def get(api, path):
    status, body = api.request('GET', path)
    if type(status) is not int or status not in (200, 404) or type(body) is not dict:
        raise ApiFailure
    return None if status == 404 else body


def obj(body, key):
    item = body.get(key) if type(body) is dict else None
    if type(item) is not dict:
        raise ApiFailure
    return item


def matches_droplet(d, m):
    return (type(d.get('id')) is int and d['id'] == m['droplet_id']
            and d.get('name') == m['droplet_name'] and d.get('tags') == [m['tag']]
            and type(d.get('region')) is dict and d['region'].get('slug') == m['region']
            and d.get('size_slug') == m['size'] and d.get('vpc_uuid') == m['vpc_id']
            and d.get('created_at') == m['created_at'])


def matches_firewall(f, m):
    return (f.get('id') == m['firewall_id'] and f.get('name') == m['firewall_name']
            and f.get('tags') == [m['tag']]
            and type(f.get('droplet_ids')) is list
            and (f['droplet_ids'] == [] or
                 (len(f['droplet_ids']) == 1 and type(f['droplet_ids'][0]) is int
                  and f['droplet_ids'][0] == m['droplet_id'])))


def tag_resources(body, m):
    tag = obj(body, 'tag')
    resources = obj(tag, 'resources')
    count = resources.get('count')
    droplet_count = obj(resources, 'droplets').get('count')
    if (tag.get('name') != m['tag'] or type(count) is not int or type(droplet_count) is not int
            or count < 0 or droplet_count < 0 or count != droplet_count):
        raise ApiFailure
    return resources


def tagged_droplets(api, m):
    result = get(api, '/v2/droplets?tag_name=' + m['tag'])
    if result is None or type(result.get('droplets')) is not list:
        raise ApiFailure
    links = obj(result, 'links')
    pages = links.get('pages', {})
    if type(pages) is not dict or ('next' in pages and type(pages['next']) is not str):
        raise ApiFailure
    if pages.get('next'):
        raise ApiFailure
    total = obj(result, 'meta').get('total')
    if type(total) is not int or total != len(result['droplets']):
        raise ApiFailure
    ids = [d.get('id') if type(d) is dict else None for d in result['droplets']]
    if len(ids) > 1 or any(type(i) is not int or i != m['droplet_id'] for i in ids):
        raise ApiFailure
    return len(ids)


def snapshot_present(api, m):
    body = get(api, '/v2/snapshots/' + m['snapshot_id'])
    return body is not None and obj(body, 'snapshot').get('id') == m['snapshot_id']


def inspect(api, m):
    """GET-only full-scope check, before any destructive request."""
    if not snapshot_present(api, m):
        return 'blocked_snapshot', None
    paths = {'droplet': '/v2/droplets/' + str(m['droplet_id']),
             'firewall': '/v2/firewalls/' + m['firewall_id'],
             'tag': '/v2/tags/' + m['tag']}
    d, f, t = (get(api, paths[k]) for k in ('droplet', 'firewall', 'tag'))
    if d is not None and not matches_droplet(obj(d, 'droplet'), m):
        return 'blocked_identity', None
    if f is not None and not matches_firewall(obj(f, 'firewall'), m):
        return 'blocked_shared_resource', None
    if (d is not None or f is not None) and t is None:
        return 'blocked_shared_resource', None
    if t is not None and tag_resources(t, m)['droplets']['count'] != int(d is not None):
        return 'blocked_shared_resource', None
    if tagged_droplets(api, m) != int(d is not None):
        return 'blocked_shared_resource', None
    if not snapshot_present(api, m):
        return 'blocked_snapshot', None
    return 'identity_verified' if any((d, f, t)) else 'absent_verified', paths


def intent(m, kind, identity):
    """Durable write-ahead marker: ambiguous DELETE is never sent a second time."""
    directory = safe_path(str(Path(m['evidence_root']) / m['run_id']))
    if not directory.is_dir() or (os.name != 'nt' and stat.S_IMODE(directory.stat().st_mode) & 0o077):
        raise ValueError('private_run_directory_required')
    path = str(directory / ('delete-' + kind + '.intent.json'))
    safe_path(path)
    record = {'run_id': m['run_id'], 'owner_id': m['owner_id'],
              'kind': kind, 'id': identity}
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        fd = os.open(path, flags, 0o600)
    except FileExistsError:
        if read_record(path) != record:
            raise ValueError('foreign_intent')
        return False
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        json.dump(record, output)
        output.flush()
        os.fsync(output.fileno())
    if os.name != 'nt':
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    return True


def delete_and_confirm(api, path, kind, m):
    identity = m['droplet_id'] if kind == 'droplet' else m['firewall_id'] if kind == 'firewall' else m['tag']
    if intent(m, kind, identity):
        status, body = api.request('DELETE', path)
        if type(status) is not int or status not in (204, 404) or type(body) is not dict:
            raise ApiFailure
    deadline = time.monotonic() + 60
    while True:
        remaining = get(api, path)
        if remaining is None:
            return True
        if kind == 'droplet' and not matches_droplet(obj(remaining, 'droplet'), m):
            raise ApiFailure
        if kind == 'firewall' and not matches_firewall(obj(remaining, 'firewall'), m):
            raise ApiFailure
        if kind == 'tag':
            tag_resources(remaining, m)
        wait = deadline - time.monotonic()
        if wait <= 0:
            return False
        time.sleep(min(1, wait))


def cleanup(m, api):
    status, paths = inspect(api, m)
    if paths is None:
        return status
    existed = status == 'identity_verified'
    for kind in ('droplet', 'firewall'):
        path = paths[kind]
        current = get(api, path)
        if current is not None:
            item = obj(current, kind)
            if kind == 'droplet':
                if not matches_droplet(item, m):
                    return 'blocked_identity'
                if tagged_droplets(api, m) != 1:
                    return 'blocked_shared_resource'
            elif not matches_firewall(item, m):
                return 'blocked_shared_resource'
        if current is not None and not delete_and_confirm(api, path, kind, m):
            return 'pending_' + kind
    tag = get(api, paths['tag'])
    if tag is not None:
        if tagged_droplets(api, m) != 0:
            return 'blocked_shared_resource'
        if tag_resources(tag, m)['count'] != 0:
            return 'pending_tag_resources'
        if not delete_and_confirm(api, paths['tag'], 'tag', m):
            return 'pending_tag'
    if not snapshot_present(api, m):
        return 'blocked_snapshot'
    return 'deleted_verified' if existed else 'already_deleted_verified'


def run(manifest, api=None, mode='check', ownership_lock=claim_lock):
    try:
        m = validate_manifest(manifest)
    except ValueError:
        return 'blocked_manifest'
    if mode == 'check':
        return 'manifest_valid'
    if mode not in ('inspect', 'delete'):
        return 'blocked_mode'
    if mode == 'delete':
        if not m['delete_authorized']:
            return 'blocked_unauthorized'
        if time.time() < m['not_before']:
            return 'not_before'
    try:
        with ownership_lock(m['lockfile']):
            if mode == 'delete' and not terminal_ready(m):
                return 'blocked_unverified_terminal'
            if api is None:
                return 'blocked_credentials'
            return inspect(api, m)[0] if mode == 'inspect' else cleanup(m, api)
    except OwnerActive:
        return 'blocked_owner_active'
    except Exception:  # No raw HTTP bodies, exceptions, paths or credentials in output.
        return 'blocked_api_error'


class DigitalOceanAPI:
    def __init__(self, token):
        if type(token) is not str or not token:
            raise ValueError('token_required')
        self._token = token
        self._opener = urllib.request.build_opener(_NoRedirect)

    def request(self, method, path, payload=None):
        if method not in ('GET', 'DELETE') or not path.startswith('/v2/') or payload is not None:
            raise ApiFailure
        request = urllib.request.Request('https://api.digitalocean.com' + path,
                                         headers={'Authorization': 'Bearer ' + self._token,
                                                  'Accept': 'application/json'}, method=method)
        try:
            with self._opener.open(request, timeout=10) as response:
                status = response.status
                data = response.read(65537) if status == 200 else b''
            if len(data) > 65536:
                raise ApiFailure
            return status, json.loads(data) if status == 200 else {}
        except urllib.error.HTTPError as exc:
            exc.close()
            return exc.code, {}
        except (OSError, ValueError):
            raise ApiFailure from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description='Opt-in DigitalOcean validation cleanup')
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--mode', choices=('check', 'inspect', 'delete'), required=True)
    args = parser.parse_args(argv)
    try:
        record = read_record(os.path.abspath(args.manifest))
        m = validate_manifest(record)
    except (OSError, ValueError, TypeError):
        print(json.dumps({'status': 'blocked_manifest'}))
        return 1
    api = None
    if args.mode != 'check':
        token = os.environ.get('DIGITALOCEAN_ACCESS_TOKEN')
        if not token:
            print(json.dumps({'status': 'blocked_credentials'}))
            return 1
        api = DigitalOceanAPI(token)
    status = run(m, api, mode=args.mode)
    print(json.dumps({'status': status, 'runId': m['run_id'],
                      'dropletId': m['droplet_id'], 'firewallId': m['firewall_id'],
                      'snapshotId': m['snapshot_id']}))
    return 0 if status in ('manifest_valid', 'identity_verified', 'absent_verified',
                            'deleted_verified', 'already_deleted_verified') else 1


if __name__ == '__main__':
    raise SystemExit(main())
