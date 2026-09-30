#!/usr/bin/env python3
"""One-shot disposable Ubuntu 24.04 DigitalOcean guard; no provider API or SSH.

Use ``--check config.json`` locally (including Windows) before any separate
operator-approved Linux execution. config.example.json is intentionally invalid:
replace its droplet ID, commit and source digest with independently verified
values. The nominal 8 CPU/16 GiB DigitalOcean plan is an external admission
prerequisite; /proc/meminfo MemTotal measures usable RAM, not plan size.

On a failed journey or PG not started, postflight records N/A for unverified
backends and cannot authorize cleanup. No automatic failure-path cloud deletion.
"""
import argparse
import hashlib
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from enum import IntEnum
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import select
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import threading
import time
from urllib.request import Request, urlopen

SLICE = 'apollo-validation.slice'
DB = 'apollo_synthetic_wave24_e2e'
APP_PREFIX = 'apollo-video-e2e-synthetic-wave24-'
METADATA = 'http://169.254.169.254/metadata/v1/id'
REDACT = re.compile(r'(?i)(postgres(?:ql)?://[^\s:@/]+:)[^@\s]+(@|%40)|((?:PASSWORD|SECRET|TOKEN|KEY)\s*[=:]\s*)[^\s]+')
OWNER_LOCK = Path('/run/lock/apollo-validation-owner.lock')
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 100000


class GateClosed(RuntimeError):
    pass


class PgReadiness(IntEnum):
    ACCEPTING = 0
    REJECTING = 1
    NO_RESPONSE = 2


def validate_owner_lock_stat(info):
    """Linux owner-lock inode contract; accepts controlled stat data in unit tests."""
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise GateClosed('owner lock must be a root-owned private regular file')

def assert_owner_lock_path(path, fd):
    """Never mutate a descriptor if its pathname no longer names the same inode."""
    info = os.fstat(fd)
    if sys.platform == 'linux':
        validate_owner_lock_stat(info)
    named = os.lstat(path)
    if not stat.S_ISREG(named.st_mode) or (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
        raise GateClosed('owner lock pathname replaced or changed')

@contextmanager
def owner_lock(run, duration, path=OWNER_LOCK):
    """Nonblocking global owner lock. Stale metadata requires operator review."""
    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    if sys.platform == 'linux' and not nofollow:
        raise GateClosed('owner lock requires O_NOFOLLOW')
    flags = os.O_RDWR | getattr(os, 'O_NONBLOCK', 0) | nofollow
    try:
        fd = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # A pre-existing object is never chmodded, unlinked, or opened with O_CREAT.
        fd = os.open(path, flags)
    locked = False
    try:
        assert_owner_lock_path(path, fd)
        if os.name == 'nt':
            import msvcrt
            if not os.fstat(fd).st_size: os.write(fd, b' ')
            os.lseek(fd, 0, os.SEEK_SET)
            try: msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError as exc: raise GateClosed('another owner holds lock') from exc
        else:
            import fcntl
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc: raise GateClosed('another owner holds lock') from exc
        locked = True
        assert_owner_lock_path(path, fd)
        os.lseek(fd, 0, os.SEEK_SET)
        if os.read(fd, 4096).strip(): raise GateClosed('stale owner record; operator review required')
        now = datetime.now(timezone.utc)
        record = {'runId': run, 'pid': os.getpid(), 'startUTC': now.isoformat().replace('+00:00', 'Z'),
                  'deadlineUTC': (now + timedelta(seconds=duration)).isoformat().replace('+00:00', 'Z')}
        payload = json.dumps(record).encode()
        assert_owner_lock_path(path, fd)
        os.lseek(fd, 0, os.SEEK_SET); os.write(fd, payload); os.ftruncate(fd, len(payload)); os.fsync(fd)
        try:
            yield record
        finally:
            assert_owner_lock_path(path, fd)
            os.lseek(fd, 0, os.SEEK_SET)
            if os.read(fd, len(payload) + 1) != payload:
                raise GateClosed('owner record changed; refusing to clear')
            assert_owner_lock_path(path, fd)
            os.ftruncate(fd, 0); os.fsync(fd)
    finally:
        try:
            if locked:
                if os.name == 'nt':
                    import msvcrt
                    os.lseek(fd, 0, os.SEEK_SET); msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else: fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def pg_activity_sql(run):
    name = pg_application_name(run)
    return ("select count(*),current_setting('max_connections'),"
            "count(*) filter(where datname='"+DB+"' and application_name='"+name+"'),"
            "count(*) filter(where datname='"+DB+"' and application_name<>'"+name+"' and pid<>pg_backend_pid()) "
            "from pg_stat_activity")

def pg_application_name(run):
    return APP_PREFIX + run


def redact(text, values=()):
    for value in sorted((v for v in values if v), key=len, reverse=True):
        text = text.replace(value, '[REDACTED]')
    return REDACT.sub(lambda m: (m[1] + '[REDACTED]' + m[2]) if m[1] else (m[3] + '[REDACTED]'), text)


def validate_config(c):
    if set(c) != {'run_id', 'owner_id', 'root', 'expected_droplet_id', 'expected_commit', 'source_sha256', 'duration_seconds'}:
        raise ValueError('config fields')
    r = c['run_id']
    if not isinstance(r, str) or not re.fullmatch('[a-z0-9](?:[a-z0-9-]{0,27}[a-z0-9])?', r) or len(pg_application_name(r).encode('utf8')) > 63:
        raise ValueError('run_id')
    if not isinstance(c['owner_id'], str) or not re.fullmatch('[a-zA-Z0-9_-]{1,64}', c['owner_id']):
        raise ValueError('owner_id')
    if c['root'] != f'/opt/apollo-validation/{r}' or not PurePosixPath(c['root']).is_absolute():
        raise ValueError('root scope')
    if type(c['expected_droplet_id']) is not int or c['expected_droplet_id'] <= 0:
        raise ValueError('droplet id')
    if any(not isinstance(c[k], str) or not re.fullmatch('[0-9a-f]{64}' if k == 'source_sha256' else '[0-9a-f]{40}', c[k]) for k in ('source_sha256', 'expected_commit')):
        raise ValueError('hash or commit')
    if type(c['duration_seconds']) is not int or not 300 <= c['duration_seconds'] <= 10800:
        raise ValueError('duration')
    return c


def check_identity(expected):
    with urlopen(Request(METADATA, headers={'Metadata-Flavor': 'DigitalOcean'}), timeout=3) as response:
        raw = response.read(64).decode('ascii').strip()
    if raw != str(expected):
        raise GateClosed('droplet metadata identity mismatch')


def verdict(sample, high):
    try:
        if any(not math.isfinite(float(sample[k])) for k in ('busy', 'steal', 'load_ratio', 'available_kib', 'oom_delta')):
            return 'invalid', 0
        if sample['busy'] < 0 or sample['busy'] > 100 or sample['steal'] < 0 or sample['steal'] > 100 or sample['load_ratio'] < 0 or sample['available_kib'] < 0 or sample['oom_delta'] < 0:
            return 'invalid', 0
        high = high + 1 if sample['busy'] >= 50 else 0
        if sample['busy'] >= 70: return 'busy', high
        if high >= 4: return 'busy_sustained', high
        if sample['steal'] >= 10: return 'steal', high
        if sample['load_ratio'] >= .75: return 'load', high
        if sample['available_kib'] < 2097152: return 'memory', high
        if sample['oom_delta'] > 0: return 'oom', high
        return None, high
    except (KeyError, TypeError, ValueError):
        return 'invalid', 0


def counters():
    raw = Path('/proc/stat').read_text().splitlines()[0].split()
    if raw[0] != 'cpu' or len(raw) < 9:
        raise GateClosed('invalid /proc/stat')
    v = list(map(int, raw[1:9]))
    return sum(v), v[0]+v[1]+v[2]+v[5]+v[6], v[7], v[4]


def host_read(previous):
    now = counters()
    total = now[0]-previous[0]
    if total <= 0 or any(now[i] < previous[i] for i in range(4)):
        raise GateClosed('invalid CPU counters')
    info = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line)
    vm = dict(line.split()[:2] for line in Path('/proc/vmstat').read_text().splitlines())
    available = int(info['MemAvailable'].split()[0]); oom = int(vm['oom_kill'])
    cpus = os.cpu_count()
    if not cpus or cpus < 1:
        raise GateClosed('invalid ncpu')
    return now, {'busy': 100*(now[1]-previous[1])/total,
                 'steal': 100*(now[2]-previous[2])/total,
                 'iowait': 100*(now[3]-previous[3])/total,
                 'load1': os.getloadavg()[0], 'ncpu': cpus,
                 'load_ratio': os.getloadavg()[0]/cpus,
                 'available_kib': available, 'oom_total': oom}

def validate_host_capacity(cpus, total_kib):
    # MemTotal is Linux usable RAM, less than nominal installed RAM (kernel reservation).
    # 12 GiB aggregate slice + at least 3 GiB host margin; the nominal 8 CPU/16 GiB
    # DigitalOcean plan must still be verified independently before admission.
    if not cpus or cpus < 8 or total_kib < 15 * 1024 * 1024:
        raise GateClosed('requires at least 8 CPUs and 15 GiB Linux usable MemTotal')

def check_host_capacity():
    meminfo = dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line)
    validate_host_capacity(os.cpu_count(), int(meminfo['MemTotal'].split()[0]))


def safe_extract(archive, dest):
    if dest.exists() and any(dest.iterdir()):
        raise GateClosed('nonempty source')
    with tarfile.open(archive, 'r:') as tar:
        members = []; total = 0
        for m in tar:
            if len(members) >= MAX_ARCHIVE_MEMBERS:
                raise GateClosed('archive member count')
            p = PurePosixPath(m.name)
            if p.is_absolute() or not m.name or any(x in ('..', '') for x in p.parts) or not (m.isfile() or m.isdir()):
                raise GateClosed('unsafe archive member')
            if m.size < 0 or m.name.startswith('-'):
                raise GateClosed('unsafe archive size/name')
            if m.isfile():
                total += m.size
                if total > MAX_ARCHIVE_BYTES:
                    raise GateClosed('archive byte budget exceeded')
            members.append(m)
        if not members: raise GateClosed('archive member count')
        if archive.stat().st_size > MAX_ARCHIVE_BYTES + MAX_ARCHIVE_MEMBERS * 1024 + 1024:
            raise GateClosed('archive physical budget exceeded')
        dest.mkdir(mode=0o700, parents=True, exist_ok=False) if not dest.exists() else None
        tar.extractall(dest, members=members, filter='data')

def service_budget():
    return '[Service]\nSlice='+SLICE+'\nCPUQuota=25%\n'

def linux_stdin_waiter(fd):
    """Linux-only SSH transport HUP/ERR observation; no Windows production path."""
    poll = select.poll()
    poll.register(fd, select.POLLHUP | select.POLLERR)
    return lambda timeout: bool(poll.poll(int(timeout * 1000)))

def write_pg_env(path, password):
    # Docker env-file, never an argv argument or a phase log. Libpq needs PGPASSWORD
    # even when the server image itself was initialized with POSTGRES_PASSWORD.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf8') as f:
        f.write('POSTGRES_USER=postgres\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD='+password+'\nPGPASSWORD='+password+'\n')


def command(argv, *, timeout, log=None, input_data=None, secrets_values=(), monitor=None, env=None, scope=False, cwd=None):
    if scope:
        argv = ['systemd-run', '--quiet', '--scope', '--slice='+SLICE, '-p', 'AllowedCPUs=0,1', '--'] + list(argv)
    argv = list(map(str, argv))
    output = []; reader_errors = []
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
                            env=env, cwd=cwd)
    def reader():
        try:
            for line in iter(proc.stdout.readline, b''):
                safe = redact(line.decode('utf-8', 'replace'), secrets_values)
                if sum(map(len, output)) < 120000:
                    output.append(safe)
                if log:
                    with open(log, 'a', encoding='utf8') as f:
                        f.write(safe)
        except BaseException as exc:
            reader_errors.append(type(exc).__name__)
    t = threading.Thread(target=reader, daemon=True); t.start()
    try:
        if input_data is not None:
            proc.stdin.write(input_data.encode()); proc.stdin.close()
        end = time.monotonic() + timeout
        while proc.poll() is None:
            if monitor: monitor.check()
            if time.monotonic() >= end:
                raise GateClosed('command deadline exceeded')
            time.sleep(.2)
    except BaseException:
        if proc.poll() is None:
            if hasattr(os, 'killpg'): os.killpg(proc.pid, signal.SIGTERM)
            else: proc.terminate()  # unittest on Windows; deployed guard is Linux only
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                if hasattr(os, 'killpg'): os.killpg(proc.pid, signal.SIGKILL)
                else: proc.kill()
                proc.wait(timeout=5)
        raise
    finally:
        if proc.stdin and not proc.stdin.closed: proc.stdin.close()
        t.join(timeout=8)
        if t.is_alive():
            proc.stdout.close()
            raise GateClosed('command output reader did not terminate')
        proc.stdout.close()
        proc.wait()
    if reader_errors: raise GateClosed('command output reader failed: '+reader_errors[0])
    if proc.returncode:
        raise GateClosed(f'command exited {proc.returncode}: {redact(" ".join(argv[:3]), secrets_values)}: {"".join(output)[-300:]}')
    return ''.join(output).strip()


def container_identity(name, run):
    out = command(['docker', 'inspect', '-f', '{{index .Config.Labels "apollo.run"}}|{{.State.Running}}|{{.State.Pid}}', name], timeout=8)
    parts = out.split('|')
    if len(parts) != 3 or parts[0] != run or parts[1] not in ('true', 'false') or not parts[2].isdigit():
        raise GateClosed('container identity mismatch: '+name)
    return parts[1] == 'true', int(parts[2])

def runner_arguments(root, run, runner_env, tools_dir):
    return ['docker','create','--name',run+'-runner','--label','apollo.run='+run,'--cgroup-parent='+SLICE,
            '--cpuset-cpus=0,1','--cpus=1.5','--memory=9g','--memory-swap=9g','--pids-limit=1536',
            '--shm-size=512m','--init','--restart=no','--network=host','--env-file',str(runner_env),
            '-v',root+'/source:'+root+'/source','-v',root+'/state:'+root+'/state',
            '-v',root+'/evidence:'+root+'/evidence','-v',root+'/logs:'+root+'/logs',
            '-v',str(tools_dir)+':'+str(tools_dir)+':ro',
            '-w',root+'/source','apollo-validation-runner:'+run,'bash',str(tools_dir/'batch.sh'),root,run]

def batch_phases():
    """Read the actual batch's phase declarations, not a second hardcoded checklist."""
    source = (Path(__file__).resolve().parent/'batch.sh').read_text()
    phases = re.findall(r'^phase ([a-z0-9-]+) \d+ ', source, flags=re.MULTILINE)
    if not phases or phases[-1] != 'synthetic-wave24-journey' or len(set(phases)) != len(phases):
        raise GateClosed('invalid batch phase specification')
    return phases


def emit(obj):
    try:
        print(json.dumps(obj, sort_keys=True), flush=True)
    except BrokenPipeError:
        # SSH stdout is not the owner; never skip finally/cleanup on disconnect.
        try: sys.stdout = open(os.devnull, 'w')
        except OSError: pass


class Monitor:
    def __init__(self, root, run):
        self.root = root; self.run = run; self.failure = None; self.stop = threading.Event()
        self.thread = None; self.high = 0; self.prev = counters(); self.last_oom = None
        self.pg = None; self.runner = None; self.runner_running_seen = False
        self.next_started = None; self.next_seen = False; self.next_ready = False
        self.port = None; self.samples = 0; self.windows = {}
        self.lock = threading.Lock()
        self.stage = 'continuous'; self.closed = threading.Event()
        self.stdin_thread = None

    def start_stdin_observer(self, wait_factory=linux_stdin_waiter, stream=None):
        """The injected factory is only a test seam; production always uses Linux poll."""
        if self.stdin_thread:
            raise GateClosed('stdin observer already started')
        try:
            fd = (stream if stream is not None else sys.stdin).fileno()
            wait = wait_factory(fd)
        except BaseException as exc:
            self.failure = f'stdin observer initialization: {type(exc).__name__}: {exc}'
            raise GateClosed(self.failure) from exc

        def observe():
            try:
                while not self.stop.is_set():
                    event = wait(.2)
                    if event is True:
                        self.closed.set()
                        self.failure = 'SSH stdin EOF; owner disconnected'
                        return
                    if event is not False:
                        raise GateClosed('stdin observer returned invalid result')
            except BaseException as exc:
                self.failure = f'stdin observer: {type(exc).__name__}: {exc}'

        self.stdin_thread = threading.Thread(target=observe)
        self.stdin_thread.start()
        self.check()

    def set_container(self, kind, value):
        with self.lock: setattr(self, kind, value)

    def check(self):
        if self.closed.is_set(): raise GateClosed('SSH stdin EOF; owner disconnected')
        if self.failure: raise GateClosed(self.failure)
        if self.stdin_thread and not self.stop.is_set() and not self.stdin_thread.is_alive():
            self.failure = 'stdin observer stopped unexpectedly'
            raise GateClosed(self.failure)

    def sample(self, stage):
        with self.lock:
            self._sample(stage)

    def _sample(self, stage):
        self.prev, v = host_read(self.prev)
        oom = v.pop('oom_total')
        v['oom_delta'] = oom if self.last_oom is None else oom - self.last_oom
        self.last_oom = oom
        reason, self.high = verdict(v, self.high)
        record = {'stage': stage, 'at': time.time(), 'monotonic_at': time.monotonic(),
                  **v, 'pg': 'N/A (not started)', 'app': 'N/A (not started)', 'reason': reason}
        if self.pg and self.pg != 'stopped':
            running, _ = container_identity(self.pg, self.run)
            if not running: reason = reason or 'pg_stopped'
            else:
                raw = command(['docker','exec',self.pg,'psql','-U','postgres','-d','postgres','-At','-F','|','-c',pg_activity_sql(self.run)],timeout=4)
                total, maximum, ours, strangers = map(int, raw.split('|'))
                record['pg'] = {'total': total, 'max_connections': maximum, 'ours': ours, 'strangers': strangers}
                if maximum <= 0 or total * 2 > maximum or strangers: reason = reason or 'pg_connections'
        elif self.pg == 'stopped': record['pg'] = {'state':'stopped', 'orphan_backends':'N/A (see cleanup verification)'}
        if self.runner and self.runner != 'stopped':
            running, _ = container_identity(self.runner, self.run)
            if running:
                self.runner_running_seen = True
                seen, port = self.find_next(self.runner)
                if seen:
                    self.next_seen = True
                    if self.next_started is None: self.next_started = time.monotonic()
                if port:
                    if self.port and port != self.port: reason = reason or 'next_port_changed'
                    self.port = port
                    from urllib.error import URLError
                    start = time.monotonic()
                    try:
                        with urlopen(f'http://127.0.0.1:{port}/v1/health', timeout=2) as resp:
                            status = resp.status
                    except (URLError, TimeoutError, OSError):
                        status = None
                    record['app'] = {'port': port, 'status': status, 'latency_seconds': round(time.monotonic()-start, 3)}
                    if status == 200: self.next_ready = True
                    elif self.next_ready: reason = reason or 'app_health'
                elif self.next_ready:
                    marker = self.root/'evidence'/'journey'/self.run/'next.log'
                    if marker.is_file(): record['app'] = {'state':'expected_teardown', 'last_port':self.port}
                    else: reason = reason or 'next_missing'
                if not self.next_ready and self.next_started is not None and time.monotonic()-self.next_started > 180:
                    reason = reason or 'next_startup'
            else:
                status = command(['docker','inspect','-f','{{.State.ExitCode}}',self.runner],timeout=4)
                marker = self.root/'evidence'/'journey'/self.run/'next.log'
                if not self.runner_running_seen and status == '0':
                    record['app'] = {'state':'created_not_started'}
                else:
                    if status != '0' or not marker.is_file(): reason = reason or 'runner_stopped_unexpected'
                    record['app'] = {'state':'expected_teardown', 'runner_exit':status, 'last_port':self.port}
        elif self.runner == 'stopped': record['app'] = {'state':'stopped', 'runner_exit':0}
        record['reason'] = reason
        with open(self.root/'evidence'/'samples.jsonl', 'a', encoding='utf8') as f:
            f.write(json.dumps(record, sort_keys=True)+'\n')
        self.samples += 1
        emit({'event':'heartbeat', **record})
        if reason: raise GateClosed(reason)

    @staticmethod
    def find_next(container_name, proc=Path('/proc')):
        # Caller verified label. Docker top scopes host PIDs; argv survives Next's process.title rewrite.
        raw = command(['docker', 'top', container_name, '-eo', 'pid,args'], timeout=4)
        pids = set()
        for line in raw.splitlines()[1:]:
            match = re.match(r'\s*(\d+)\s+(.+)', line)
            if match and (re.search(r'\bnext-server\s*\(v?\d',match[2]) or
                          re.search(r'next/dist/bin/next\s+start\b',match[2])):
                pids.add(int(match[1]))
        inodes = set()
        for pid in pids:
            try:
                for fd in (proc/str(pid)/'fd').iterdir():
                    try:
                        link = os.readlink(fd)
                        match = re.fullmatch(r'socket:\[(\d+)\]', link)
                        if match: inodes.add(match[1])
                    except (FileNotFoundError, PermissionError): continue
            except FileNotFoundError: continue  # process exited between top and fd enumeration
        ports = set()
        for table in ('tcp','tcp6'):
            for row in (proc/'net'/table).read_text().splitlines()[1:]:
                cols = row.split()
                if len(cols) >= 10 and cols[3] == '0A' and cols[9] in inodes:
                    port = int(cols[1].rsplit(':',1)[1],16)
                    if not 1 <= port <= 65535: raise GateClosed('invalid Next port')
                    ports.add(port)
        if len(ports) > 1: raise GateClosed('multiple Next ports')
        return bool(pids), next(iter(ports), None)

    def window(self, stage):
        if stage != 'postflight': self.check()
        started = time.monotonic()
        if self.thread:
            with self.lock: self.stage = stage; before = self.samples
            deadline = started + 80
            try:
                while True:
                    with self.lock: count = self.samples - before
                    now = time.monotonic()
                    if count >= 6 and now - started >= 60: break
                    if stage != 'postflight': self.check()
                    if now >= deadline or not self.thread.is_alive():
                        raise GateClosed('postflight sampling incomplete or monitor stopped')
                    if self.stop.wait(.2): raise GateClosed('monitor stopped during postflight')
            finally:
                with self.lock: self.stage = 'continuous'
            if stage != 'postflight': self.check()
        else:
            tick = started
            errors = []
            for _ in range(6):
                tick += 10
                time.sleep(max(0,tick-time.monotonic()))
                try:
                    if time.monotonic()-tick > 1: raise GateClosed('monitor cadence overrun')
                    if stage != 'postflight': self.check()
                    self.sample(stage)
                except BaseException as exc:
                    if stage != 'postflight': raise
                    errors.append(str(exc))
            if errors: raise GateClosed('postflight sampling inconclusive: '+errors[0])
        finished = time.monotonic()
        if finished - started < 60: raise GateClosed('sampling window shorter than 60 seconds')
        self.windows[stage] = {'started': started, 'finished': finished}

    def start(self):
        def loop():
            tick = time.monotonic()
            while not self.stop.is_set():
                tick += 10
                if self.stop.wait(max(0,tick-time.monotonic())): return
                try:
                    if time.monotonic()-tick > 1: raise GateClosed('monitor cadence overrun')
                    self.sample(self.stage)
                except BaseException as exc:
                    if self.failure is None: self.failure = f'monitor: {type(exc).__name__}: {exc}'
                    # Keep collecting lightweight postflight samples after a sticky gate.
        self.thread = threading.Thread(target=loop, daemon=True); self.thread.start()

    def await_sample(self):
        if not self.thread:
            self.sample('cleanup_between_stops')
            return
        before = self.samples
        deadline = time.monotonic() + 20
        while self.samples == before:
            if not self.thread.is_alive() or time.monotonic() >= deadline:
                raise GateClosed('monitor missing between runner and PG stop; PG preserved')
            time.sleep(.2)

    def finish(self):
        self.stop.set()
        if self.thread: self.thread.join(timeout=15)
        if self.thread and self.thread.is_alive(): raise GateClosed('monitor did not stop')
        if self.stdin_thread: self.stdin_thread.join(timeout=3)
        if self.stdin_thread and self.stdin_thread.is_alive(): raise GateClosed('stdin observer did not stop')


class Run:
    def __init__(self, c):
        self.c = c; self.root = Path(c['root']); self.run = c['run_id']
        self.pg = self.run+'-pg'; self.runner = self.run+'-runner'
        self.monitor = None; self.secret = None
        self.deadline = time.monotonic()+c['duration_seconds']; self.reserve = 180
        self.phases = []; self.pids = {}; self.orphans = 'N/A'; self.cleanup_ok = False
        self.create_attempted = set(); self.created = set()
        self.owner_record = None; self.in_cleanup = False; self.signal_reason = None
        self.owns_root = False; self.root_identity = None
        self.container_states = {'runner':'never_started','pg':'never_started'}

    def step(self, name, args, seconds=600, *, scope=True, env=None, input_data=None, sensitive=False):
        if self.monitor: self.monitor.check()
        left = self.deadline-time.monotonic()-self.reserve
        if left <= 0: raise GateClosed('total deadline/cleanup reserve')
        log = self.root/'logs'/f'{name}.log'
        emit({'event':'phase_start','phase':name})
        start = time.monotonic()
        try:
            out = command(args, timeout=min(seconds,left), log=None if sensitive else log,
                          monitor=self.monitor, env=env, scope=scope, input_data=input_data,
                          secrets_values=(self.secret,) if self.secret else ())
            self.phases.append({'phase':name,'exit_code':0,'seconds':round(time.monotonic()-start,2)})
            emit({'event':'phase_result','phase':name,'exit_code':0})
            return out
        except BaseException as exc:
            self.phases.append({'phase':name,'exit_code':1,'reason':redact(str(exc),(self.secret,))})
            emit({'event':'phase_result','phase':name,'exit_code':1})
            raise

    def files(self):
        if os.geteuid() != 0 or Path('/var/lib/docker').exists() or subprocess.call(['systemctl','is-active','--quiet','docker']) == 0:
            raise GateClosed('requires fresh exclusive root Ubuntu host without Docker')
        if Path('/etc/docker/daemon.json').exists() or (Path('/etc/systemd/system')/SLICE).exists():
            raise GateClosed('Docker configuration already exists')
        for service in ('docker','containerd'):
            if (Path('/etc/systemd/system')/(service+'.service.d')/'apollo-budget.conf').exists():
                raise GateClosed(service+' configuration already exists')
        unit = Path('/etc/systemd/system')/SLICE
        unit.write_text('[Unit]\nDescription=Apollo disposable aggregate\n[Slice]\nCPUAccounting=yes\nCPUQuota=200%\nMemoryAccounting=yes\nMemoryMax=12G\nMemorySwapMax=0\nTasksMax=2048\n')
        for service in ('docker','containerd'):
            drop = Path('/etc/systemd/system')/(service+'.service.d')/'apollo-budget.conf'
            drop.parent.mkdir(parents=True, exist_ok=True)
            drop.write_text(service_budget())
        daemon = Path('/etc/docker/daemon.json'); daemon.parent.mkdir(parents=True,exist_ok=True)
        daemon.write_text(json.dumps({'exec-opts':['native.cgroupdriver=systemd'],'cgroup-parent':SLICE,'log-driver':'local','log-opts':{'max-size':'10m','max-file':'2'}})+'\n')
        self.step('systemd_reload',['systemctl','daemon-reload'],20,scope=False)
        self.step('slice_start',['systemctl','start',SLICE],20,scope=False)
        raw = self.step('slice_controls',['systemctl','show',SLICE,'-p','CPUQuotaPerSecUSec','-p','MemoryMax','-p','MemorySwapMax','-p','TasksMax'],10,scope=False)
        if not all(s in raw for s in ('CPUQuotaPerSecUSec=2s','MemoryMax=12884901888','MemorySwapMax=0','TasksMax=2048')):
            raise GateClosed('slice controls not confirmed: '+raw)

    def prepare(self):
        # git is a host prerequisite for verifying the archive, not a runner-only package.
        self.step('git_version',['git','--version'],10,scope=False)
        self.files()
        self.step('apt_update',['apt-get','update'],600)
        self.step('apt_docker',['apt-get','install','-y','--no-install-recommends','docker.io','ca-certificates'],900,
                  env={**os.environ,'DEBIAN_FRONTEND':'noninteractive'})
        # Debian package may start Docker once during installation; never restart it.
        self.step('docker_start',['systemctl','start','docker'],60,scope=False)
        for service in ('docker','containerd'):
            show = self.step(service+'_controls',['systemctl','show',service+'.service','-p','Slice','-p','CPUQuotaPerSecUSec','-p','ActiveState'],10,scope=False)
            if not all(field in show.splitlines() for field in ('Slice='+SLICE,'CPUQuotaPerSecUSec=250ms','ActiveState=active')):
                raise GateClosed(service+' slice/quota readback mismatch')
        info = self.step('docker_info',['docker','info','--format','{{.CgroupDriver}}|{{.CgroupVersion}}'],15)
        if info != 'systemd|2': raise GateClosed('Docker cgroup driver/version')
        self.step('docker_parent',['python3','-c',"import json;d=json.load(open('/etc/docker/daemon.json'));assert d['cgroup-parent']=='apollo-validation.slice' and d['exec-opts']==['native.cgroupdriver=systemd']"],10)

    def upload(self):
        emit({'event':'upload_ready','run_id':self.run,'root':str(self.root)})
        limit = min(time.monotonic()+1200, self.deadline-self.reserve)
        marker = self.root/'upload.complete'; archive = self.root/'source.tar'
        while time.monotonic()<limit:
            self.monitor.check()
            if marker.exists():
                if marker.is_symlink() or archive.is_symlink() or not archive.is_file() or marker.read_text().strip()!=self.c['source_sha256']:
                    raise GateClosed('upload marker/archive mismatch')
                return
            time.sleep(1)
        raise GateClosed('upload deadline')

    def run_work(self):
        c = self.c; root = str(self.root)
        tools_dir = Path(__file__).resolve().parent
        digest = self.step('source_hash',['sha256sum',root+'/source.tar'],300).split()[0]
        if digest != c['source_sha256']: raise GateClosed('source sha256 mismatch')
        self.step('extract',['python3','-c',
                  'import sys;sys.path.insert(0,sys.argv[1]);import remote_guard as g;g.safe_extract(__import__("pathlib").Path(sys.argv[2]),__import__("pathlib").Path(sys.argv[3]))',
                  str(tools_dir),root+'/source.tar',root+'/source'],600)
        src = self.root/'source'
        head = self.step('head',['git','-C',str(src),'rev-parse','HEAD'],10)
        if head != c['expected_commit']: raise GateClosed('source HEAD mismatch')
        if self.step('shallow',['git','-C',str(src),'rev-parse','--is-shallow-repository'],10) != 'true':
            raise GateClosed('archive must contain shallow Git repository')
        if self.step('dirty',['git','-C',str(src),'status','--porcelain','--untracked-files=normal'],15):
            raise GateClosed('source is not clean')
        versions = json.loads((src/'config/platform-versions.json').read_text())
        image = versions['database']['image']
        if not re.fullmatch(r'pgvector/pgvector:0\.8\.5-pg16-[a-z0-9-]+',image): raise GateClosed('PG image unexpected')
        env={**os.environ,'DOCKER_BUILDKIT':'0'}
        self.step('runner_build',['docker','build','--cgroup-parent='+SLICE,'--cpuset-cpus=0,1','--memory=8g','-f',str(tools_dir/'Dockerfile.runner'),'-t','apollo-validation-runner:'+self.run,str(tools_dir)],1200,env=env)
        self.step('pg_pull',['docker','pull',image],600)
        self.secret = secrets.token_urlsafe(32)
        state = self.root/'state'; state.mkdir(exist_ok=True)
        pg_env = state/'pg.env'; write_pg_env(pg_env, self.secret)
        self.step('pg_network',['docker','network','create','--driver','bridge','--label','apollo.run='+self.run,self.run+'-pgnet'],20)
        self.create_attempted.add(self.pg)
        self.step('pg_start',['docker','run','-d','--name',self.pg,'--label','apollo.run='+self.run,'--network',self.run+'-pgnet','--cgroup-parent='+SLICE,'--cpuset-cpus=0,1','--cpus=0.5','--memory=2g','--memory-swap=2g','--pids-limit=256','--restart=no','--env-file',str(pg_env),'-p','127.0.0.1:55432:5432',image,'-c','max_connections=40'],30)
        self.pids['pg']=container_identity(self.pg,self.run)[1]
        self.created.add(self.pg)
        self.wait_pg_ready()
        self.monitor.set_container('pg',self.pg)
        # Admin socket is trusted in the dedicated PG container; SQL on stdin never in argv/log.
        sql = ("CREATE ROLE apollo_e2e LOGIN PASSWORD '"+self.secret+"' CONNECTION LIMIT 10;\n"
               "ALTER ROLE apollo_e2e SET idle_session_timeout='60s';\n"
               "ALTER ROLE apollo_e2e SET idle_in_transaction_session_timeout='60s';\n"
               "CREATE DATABASE "+DB+" OWNER apollo_e2e;\n")
        self.step('pg_role_db',['docker','exec','-i',self.pg,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],20,input_data=sql,sensitive=True)
        self.step('pg_extensions',['docker','exec','-i',self.pg,'psql','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1'],20,
                  input_data='CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION pgcrypto; CREATE EXTENSION btree_gist;',sensitive=True)
        if self.step('pg_db_tcp',['docker','exec',self.pg,'psql','-h','127.0.0.1','-U','postgres','-d',DB,'-At','-c','select 1'],5) != '1':
            raise GateClosed('exact database TCP SELECT 1 failed')
        self.monitor.sample('pg_admission')
        url='postgresql://apollo_e2e:'+self.secret+'@127.0.0.1:55432/'+DB+'?schema=public&application_name=apollo-video-e2e-synthetic-wave24-'+self.run+'&connection_limit=1&pool_timeout=10&connect_timeout=10'
        runner_env=state/'runner.env'
        runner_env.write_text('\n'.join(['CI=1','V2_DATABASE_URL='+url,'APOLLO_WAVE24_RUN_ID='+self.run,
           'APOLLO_WAVE24_EVIDENCE_ROOT='+root+'/evidence/journey','APOLLO_V2_ARTIFACT_STORAGE_DRIVER=local',
           'APOLLO_API_ENVIRONMENT=production','APOLLO_RESOURCE_PROFILE=isolated-ci',
           'APOLLO_PROTECTED_PAYLOAD_KEY_ID=synthetic-wave24-ci',
           'APOLLO_PROTECTED_PAYLOAD_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
           'HOME='+root+'/state/home','TMPDIR='+root+'/state/tmp','npm_config_cache='+root+'/state/npm-cache',
           'CIRCLE_NODE_TOTAL=2','OPENBLAS_NUM_THREADS=1','OMP_NUM_THREADS=1','UV_THREADPOOL_SIZE=2',
           'NODE_OPTIONS=--max-old-space-size=4096'])+'\n'); runner_env.chmod(0o600)
        for item in ('home','tmp','npm-cache'): (state/item).mkdir(exist_ok=True)
        (src/'.env').touch(exist_ok=True)  # generated untracked file, removed after run by archive owner
        runner_args=runner_arguments(root,self.run,runner_env,tools_dir)
        self.create_attempted.add(self.runner)
        self.step('runner_create',runner_args,30)
        container_identity(self.runner,self.run)
        self.created.add(self.runner)
        self.monitor.set_container('runner',self.runner)
        self.step('runner',['docker','start','-a',self.runner],seconds=7500,sensitive=False)
        status=self.step('runner_exit',['docker','inspect','-f','{{.State.Running}}|{{.State.ExitCode}}',self.runner],10)
        if status != 'false|0': raise GateClosed('runner process did not exit successfully: '+status)
        self.verify_journey()

    def wait_pg_ready(self):
        until = time.monotonic() + 120
        probe = 'pg_isready -h 127.0.0.1 -U postgres -d postgres -q >/dev/null; rc=$?; printf "PG_READY_STATUS:%s\\n" "$rc"'
        monitor = self.monitor
        if monitor is None: raise GateClosed('PG readiness requires monitor')
        while True:
            monitor.check()
            remaining = self.deadline - time.monotonic() - self.reserve
            if remaining <= 0: raise GateClosed('total deadline/cleanup reserve')
            if time.monotonic() >= until: raise GateClosed('PG startup timeout')
            status = self.step('pg_ready', ['docker', 'exec', self.pg, 'sh', '-c', probe],
                               seconds=min(3, remaining, until - time.monotonic()))
            monitor.check()
            if self.deadline - time.monotonic() - self.reserve <= 0:
                raise GateClosed('total deadline/cleanup reserve')
            match = re.fullmatch(r'PG_READY_STATUS:([012])', status)
            if not match:
                raise GateClosed('PG readiness probe failed')
            readiness = PgReadiness(int(match[1]))
            if readiness is PgReadiness.ACCEPTING: return
            remaining = self.deadline - time.monotonic() - self.reserve
            if remaining <= 0: raise GateClosed('total deadline/cleanup reserve')
            if time.monotonic() >= until: raise GateClosed('PG startup timeout')
            time.sleep(min(2, remaining, until - time.monotonic()))

    def verify_journey(self):
        if not self.monitor.next_seen or not self.monitor.next_ready:
            raise GateClosed('Next was never observed as process and healthy listener')
        if not (self.root/'evidence'/'batch.complete').is_file():
            raise GateClosed('journey batch did not complete')
        self.verify_batch_logs()

    def verify_batch_logs(self):
        results = self.root/'evidence'/'batch-results.jsonl'
        if results.is_symlink() or not results.is_file():
            raise GateClosed('batch phase evidence missing')
        phases = [json.loads(line) for line in results.read_text().splitlines()]
        if not phases or any(not isinstance(p, dict) or not re.fullmatch('[a-z0-9-]+',str(p.get('phase','')))
                             or type(p.get('exit_code')) is not int or p['exit_code'] != 0 for p in phases):
            raise GateClosed('invalid batch phase evidence')
        if [p['phase'] for p in phases] != batch_phases():
            raise GateClosed('batch phase sequence incomplete or duplicated')
        logs = self.root/'logs'
        if logs.is_symlink() or not logs.is_dir(): raise GateClosed('batch logs directory missing')
        for phase in phases:
            path = logs/(phase['phase']+'.log')
            if path.is_symlink() or not path.is_file():
                raise GateClosed('batch log missing: '+phase['phase'])

    def cleanup(self):
        errors=[]
        # No Docker dependency before any create; uncertain create must be reconciled.
        if not self.create_attempted:
            self.cleanup_ok=True
            return errors
        runner_checked=self.runner not in self.create_attempted
        for name in (self.runner,self.pg):
            if name not in self.create_attempted: continue
            try:
                running,pid=container_identity(name,self.run)
                self.created.add(name)
            except (GateClosed, OSError) as e:
                if 'No such object' in str(e) and name not in self.created:
                    if name == self.runner: runner_checked=True
                    continue
                self.container_states['runner' if name==self.runner else 'pg']='uncertain'
                errors.append('ambiguous create/inspect '+name+': '+str(e)); continue
            self.pids[name]=pid
            if name == self.runner: runner_checked=True
            try:
                if name == self.pg:
                    # Only after runner is observed terminal and all application backends drain.
                    if not runner_checked or any('runner' in x for x in errors):
                        raise GateClosed('runner identity/stop uncertain; PG preserved')
                    rr=container_identity(self.runner,self.run) if self.runner in self.created else (False,0)
                    if rr[0] or rr[1]: raise GateClosed('runner still alive; PG must remain')
                    if self.monitor:
                        self.monitor.await_sample()
                    for _ in range(10):
                        raw=command(['docker','exec',self.pg,'psql','-U','postgres','-d','postgres','-Atc',
                            "select count(*) from pg_stat_activity where datname='"+DB+"' and application_name='apollo-video-e2e-synthetic-wave24-"+self.run+"'"],timeout=5)
                        self.orphans=int(raw)
                        if self.orphans==0: break
                        time.sleep(2)
                    if self.orphans != 0: raise GateClosed('orphan backends; PG preserved')
                if running:
                    command(['docker','stop','--time','20',name],timeout=35)
                still,pid=container_identity(name,self.run)
                if still or pid: raise GateClosed('container not terminal '+name)
                self.container_states['runner' if name==self.runner else 'pg']='stopped'
                if name == self.runner and self.monitor and self.monitor.port:
                    try:
                        with socket.create_connection(('127.0.0.1',self.monitor.port),timeout=2):
                            raise GateClosed('Next port remains open after runner stop')
                    except (ConnectionRefusedError, TimeoutError):
                        pass
                if self.monitor: self.monitor.set_container('runner' if name==self.runner else 'pg','stopped')
                # Preserve stopped container for inspection; no rm and no DROP DATABASE.
            except BaseException as e: errors.append(redact(str(e),(self.secret,)))
        self.cleanup_ok=not errors
        return errors

    def main(self):
        with owner_lock(self.run, self.c['duration_seconds']) as record:
            self.owner_record = record
            return self._main_locked()

    def postflight_result(self, exit_code, error, cleanup):
        return {'run_id':self.run,'owner_pid':self.owner_record['pid'] if self.owner_record else os.getpid(),
                'owner_id':self.c['owner_id'], 'expected_droplet_id':self.c['expected_droplet_id'],
                'source_commit':self.c['expected_commit'],
                'owner_deadline_utc':self.owner_record['deadlineUTC'] if self.owner_record else None,
                'exit_code':exit_code,'cleanup_ok':not cleanup and self.cleanup_ok and not error,
                'orphan_backends':self.orphans,'pids':self.pids,'error':error,
                'container_states':self.container_states,
                'cleanup_errors':cleanup,'errors':([error] if error else [])+cleanup,'phases':self.phases,
                'samples':self.monitor.samples if self.monitor else 0,
                'windows':self.monitor.windows if self.monitor else {}}

    def _main_locked(self):
        error=None; exit_code=1; cleanup=[]
        self.owns_root = False; self.root_identity = None
        def interrupted(sig, frame):
            self.signal_reason = 'interrupted by signal '+str(sig)
            if not self.in_cleanup: raise GateClosed(self.signal_reason)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, interrupted)
        try:
            check_identity(self.c['expected_droplet_id'])
            check_host_capacity()
            try:
                self.root.mkdir(mode=0o700)
            except FileExistsError as exc:
                raise GateClosed('root already exists; no implicit retry') from exc
            self.owns_root = True
            self.root_identity = (self.root.stat().st_dev, self.root.stat().st_ino)
            for sub in ('logs','evidence','state'): (self.root/sub).mkdir(mode=0o700)
            self.monitor=Monitor(self.root,self.run)
            self.monitor.start_stdin_observer()
            self.monitor.window('preflight')
            self.monitor.start()
            self.prepare()
            self.upload()
            self.run_work()
            self.monitor.check()
            exit_code=0
        except BaseException as exc:
            error=redact(f'{type(exc).__name__}: {exc}',(self.secret,))
        finally:
            self.in_cleanup = True
            # Even on transport disconnect/timeout, no API action and no global Docker restart.
            try:
                identity = (self.root.stat().st_dev, self.root.stat().st_ino) if not self.root.is_symlink() else None
            except OSError:
                identity = None
            if self.owns_root and identity != self.root_identity:
                emit({'event':'fatal','error':'owned root missing or replaced; refusing cleanup/evidence'})
                exit_code=1
            elif self.owns_root:
                try: cleanup += self.cleanup()
                except BaseException as exc: cleanup.append('cleanup: '+redact(str(exc),(self.secret,)))
                if self.monitor:
                    try: self.monitor.window('postflight')
                    except BaseException as exc: cleanup.append('postflight: '+str(exc))
                    if self.monitor.failure: cleanup.append(self.monitor.failure)
                    if self.monitor.closed.is_set(): cleanup.append('SSH stdin EOF; owner disconnected')
                    try: self.monitor.finish()
                    except BaseException as exc: cleanup.append('monitor finish: '+str(exc))
                if self.signal_reason: cleanup.append(self.signal_reason)
                if cleanup or error: exit_code=1
                result=self.postflight_result(exit_code,error,cleanup)
                try:
                    evidence = self.root/'evidence'
                    if not evidence.exists(): evidence.mkdir(mode=0o700)
                    if evidence.is_symlink() or (evidence/'postflight.json').is_symlink():
                        raise OSError('postflight evidence path is a symlink')
                    (evidence/'postflight.json').write_text(json.dumps(result,indent=2)+'\n')
                    emit({'event':'result','path':str(evidence/'postflight.json'),
                          'exit_code':exit_code,'cleanup_ok':result['cleanup_ok']})
                except OSError as exc:
                    emit({'event':'fatal','error':'owned-root postflight write failed: '+str(exc)})
                    exit_code=1
        return exit_code


def cli(argv=None):
    parser = argparse.ArgumentParser(description='Disposable Apollo bootstrap; --check validates config locally without network or credentials. Execution requires Linux.')
    parser.add_argument('--check', action='store_true', help='validate config syntax and scope locally; no remote actions')
    parser.add_argument('config', help='JSON config (config.example.json is intentionally not runnable)')
    args = parser.parse_args(argv)
    try:
        cfg=validate_config(json.loads(Path(args.config).read_text()))
        if args.check:
            emit({'event':'config_valid','run_id':cfg['run_id']})
            return 0
        if sys.platform != 'linux':
            raise GateClosed('Linux only; use --check for local validation')
        return Run(cfg).main()
    except (ValueError, OSError, GateClosed) as exc:
        emit({'event':'fatal','error':str(exc)})
        return 1

if __name__ == '__main__':
    raise SystemExit(cli())
