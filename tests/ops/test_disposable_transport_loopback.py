"""Real Paramiko SSH+SFTP over 127.0.0.1; no cloud, external credentials or API."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import paramiko
from paramiko.common import (AUTH_FAILED, AUTH_SUCCESSFUL, OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED,
                             OPEN_SUCCEEDED)
from paramiko.sftp import SFTP_FAILURE, SFTP_NO_SUCH_FILE, SFTP_OK, SFTP_PERMISSION_DENIED

SOURCE = Path(__file__).resolve().parents[2] / 'scripts/ops/digitalocean-validation/controller.py'
spec = importlib.util.spec_from_file_location('disposable_controller_loopback', SOURCE)
assert spec is not None and spec.loader is not None
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class LocalSFTP(paramiko.SFTPServerInterface):
    def __init__(self, server, *args, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.state = server.state

    def _path(self, path):
        name = path.rsplit('/', 1)[-1]
        if name not in ('source.tar', 'upload.complete'):
            raise ValueError('test-only path')
        return self.state['root'] / name

    def stat(self, path):
        try: return paramiko.SFTPAttributes.from_stat(self._path(path).stat())
        except FileNotFoundError: return SFTP_NO_SUCH_FILE

    def lstat(self, path):
        if self.state['stat_response'] == 'denied': return SFTP_PERMISSION_DENIED
        if self.state['stat_response'] == 'timeout': time.sleep(.25)
        return self.stat(path)

    def chattr(self, path, attr):
        try:
            self._path(path).chmod(attr.st_mode)
            return SFTP_OK
        except OSError: return SFTP_FAILURE

    def open(self, path, flags, attr):
        try:
            target = self._path(path)
            if self.state['timeout_on_read'] and target.name == 'source.tar' and not flags & os.O_WRONLY:
                time.sleep(.25)
            fd = os.open(target, flags, 0o600)
            mode = 'r+b' if flags & os.O_RDWR else 'wb' if flags & os.O_WRONLY else 'rb'
            file = os.fdopen(fd, mode, buffering=0)
            handle = paramiko.SFTPHandle(flags)
            handle.readfile = file
            handle.writefile = file
            if self.state['signal_on_write'] and target.name == 'source.tar':
                original = handle.write
                def write(offset, data):
                    result = original(offset, data)
                    if not self.state['signaled']:
                        self.state['signaled'] = True
                        self.state['control'].send_stderr(b'authorization=private-stderr\n')
                        self.state['control'].send(b'{"event":"result"}\n')
                    return result
                handle.write = write
            return handle
        except OSError: return SFTP_FAILURE


class LocalServer(paramiko.ServerInterface):
    def __init__(self, state): self.state = state
    def check_auth_publickey(self, username, key): return AUTH_SUCCESSFUL if username == 'fixture' else AUTH_FAILED
    def get_allowed_auths(self, username): return 'publickey'
    def check_channel_request(self, kind, chanid):
        return OPEN_SUCCEEDED if kind == 'session' else OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
    def check_channel_exec_request(self, channel, command):
        self.state['control'] = channel
        channel.send(b'{"event":"upload_ready"}\n')
        return True


class LoopbackTransportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / 'archive'
        self.archive.write_bytes(b'A' * (2 * 1024 * 1024 + 17))
        self.digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.state = dict(root=self.root, timeout_on_read=False, signal_on_write=False,
                          signaled=False, control=None, stat_response=None)
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.listener.listen(1)
        self.listener.settimeout(3)
        self.host_key = paramiko.RSAKey.generate(1024)
        self.login_key = paramiko.RSAKey.generate(1024)
        self.server_transport = None
        self.server_error = []
        def serve():
            try:
                connection, _ = self.listener.accept()
                self.server_transport = paramiko.Transport(connection)
                self.server_transport.add_server_key(self.host_key)
                self.server_transport.set_subsystem_handler('sftp', paramiko.SFTPServer, LocalSFTP)
                self.server_transport.start_server(server=LocalServer(self.state))
                while self.server_transport.is_active() and not self.stopping.is_set():
                    self.stopping.wait(.02)
            except (OSError, paramiko.SSHException) as exc:
                self.server_error.append(type(exc).__name__)
            finally:
                if self.server_transport: self.server_transport.close()
        self.stopping = threading.Event()
        self.server_thread = threading.Thread(target=serve, name='apollo-loopback-server')
        self.server_thread.start()
        self.client = paramiko.SSHClient()
        self.client.get_host_keys().add(f'[127.0.0.1]:{self.listener.getsockname()[1]}',
                                        'ssh-rsa', self.host_key)
        try:
            self.client.connect('127.0.0.1', port=self.listener.getsockname()[1],
                                username='fixture', pkey=self.login_key, look_for_keys=False,
                                allow_agent=False, timeout=2, auth_timeout=2, banner_timeout=2)
            self.sftp = self.client.open_sftp()
            self.sftp.get_channel().settimeout(.1)  # test-only seam; production stays at 10 s
            self.control = self.client.get_transport().open_session(timeout=2)
            self.control.settimeout(.1)
            self.control.exec_command('test-only')
        except BaseException:
            self.tearDown()
            raise

    def tearDown(self):
        if hasattr(self, 'sftp'): self.sftp.close()
        if hasattr(self, 'client'): self.client.close()
        self.stopping.set()
        self.listener.close()
        if self.server_transport:
            self.server_transport.close()
            self.server_transport.join(timeout=2)
        self.server_thread.join(timeout=2)
        self.assertFalse(self.server_thread.is_alive(), 'server thread leaked')
        if self.server_transport: self.assertFalse(self.server_transport.is_alive(), 'SSH transport leaked')
        self.assertFalse(self.server_error, self.server_error)

    def pump(self):
        if self.control.recv_stderr_ready(): self.control.recv_stderr(65536)
        if self.control.recv_ready():
            data = self.control.recv(65536)
            if b'"result"' in data: raise controller.Blocked('guard_result_during_upload')

    def test_real_upload_readback_sha_and_marker(self):
        self.assertIn(b'upload_ready', self.control.recv(4096))
        result = controller.transfer_source(self.sftp, self.archive, '/fixture', self.digest,
                                            self.root, self.pump, time.monotonic() + 15)
        self.assertEqual(result, self.digest)
        self.assertEqual((self.root / 'source.tar').read_bytes(), self.archive.read_bytes())
        self.assertEqual((self.root / 'upload.complete').read_bytes(), (self.digest + '\n').encode())
        statuses = [json.loads(line)['status'] for line in (self.root / 'controller.jsonl').read_text().splitlines()]
        self.assertEqual(statuses, ['transfer_started', 'transfer_phase', 'transfer_finished'])

    def test_real_control_result_and_stderr_interrupt_upload_without_marker(self):
        self.assertIn(b'upload_ready', self.control.recv(4096))
        self.state['signal_on_write'] = True
        with self.assertRaisesRegex(controller.Blocked, 'guard_result_during_upload'):
            controller.transfer_source(self.sftp, self.archive, '/fixture', self.digest,
                                       self.root, self.pump, time.monotonic() + 15)
        self.assertTrue(self.state['signaled'])
        self.assertFalse((self.root / 'upload.complete').exists())
        self.assertNotIn('private-stderr', (self.root / 'controller.jsonl').read_text())

    def test_real_sftp_timeout_has_safe_readback_callsite(self):
        self.assertIn(b'upload_ready', self.control.recv(4096))
        self.state['timeout_on_read'] = True
        with self.assertRaises((TimeoutError, socket.timeout)):
            controller.transfer_source(self.sftp, self.archive, '/fixture', self.digest,
                                       self.root, self.pump, time.monotonic() + 15)
        rows = [json.loads(line) for line in (self.root / 'controller.jsonl').read_text().splitlines()]
        self.assertEqual(rows[-1]['status'], 'transfer_failed')
        self.assertEqual(rows[-1]['phase'], 'readback')
        self.assertEqual(rows[-1]['callsite'], 'transfer_source')
        self.assertFalse((self.root / 'upload.complete').exists())

    def test_expired_deadline_never_sends_marker(self):
        self.assertIn(b'upload_ready', self.control.recv(4096))
        with self.assertRaisesRegex(controller.Blocked, 'guard_deadline_unknown'):
            controller.transfer_source(self.sftp, self.archive, '/fixture', self.digest,
                                       self.root, self.pump, time.monotonic() - 1)
        self.assertFalse((self.root / 'upload.complete').exists())

    def test_real_permission_lstat_blocks_source_before_open(self):
        self.assertIn(b'upload_ready', self.control.recv(4096))
        self.state['stat_response'] = 'denied'
        with patch.object(self.sftp, 'open', wraps=self.sftp.open) as opened:
            with self.assertRaises(PermissionError):
                controller.transfer_source(self.sftp, self.archive, '/fixture', self.digest,
                                           self.root, self.pump, time.monotonic() + 15)
            opened.assert_not_called()
        self.assertFalse((self.root / 'upload.complete').exists())

    def test_real_timeout_lstat_blocks_tool_before_open(self):
        self.assertIn(b'upload_ready', self.control.recv(4096))
        self.state['stat_response'] = 'timeout'
        with patch.object(self.sftp, 'open', wraps=self.sftp.open) as opened:
            with self.assertRaises(TimeoutError):
                controller.remote_write(self.sftp, '/fixture/upload.complete', b'fixture')
            opened.assert_not_called()
        self.assertFalse((self.root / 'upload.complete').exists())


if __name__ == '__main__': unittest.main()
