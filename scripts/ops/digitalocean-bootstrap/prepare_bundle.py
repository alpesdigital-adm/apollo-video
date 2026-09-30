#!/usr/bin/env python3
"""Prepare an offline, shallow, tracked-only source snapshot (not an E2E run)."""
import argparse
import hashlib
import json
import os
import signal
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
COMMIT = re.compile(r'[0-9a-fA-F]{40}\Z')
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024  # Total unpacked regular-file bytes.
MAX_ARCHIVE_MEMBERS = 100000  # Files and directories, including Git metadata.
GIT_TOTAL_SECONDS = 300
GIT_COMMAND_SECONDS = 120
SOURCE_CREDENTIAL_ROUTES = frozenset({
    'src/app/v1/workspaces/[workspaceId]/clients/[clientId]/credentials/route.ts',
    'src/app/v1/workspaces/[workspaceId]/clients/[clientId]/credentials/[credentialId]/route.ts',
})


class BundleError(Exception):
    pass


class GitEnvironment(dict):
    def __init__(self, values):
        super().__init__(values)
        self.deadline = time.monotonic() + GIT_TOTAL_SECONDS


def git(cwd, env, *args, input_data=None, timeout=GIT_COMMAND_SECONDS, command_prefix=None):
    remaining = min(timeout, getattr(env, 'deadline', float('inf')) - time.monotonic())
    if remaining <= 0:
        raise BundleError('Git deadline exceeded')
    prefix = command_prefix or ('git', '-c', 'core.fsmonitor=false',
                                '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
                                '-c', 'core.hooksPath=' + env['GIT_TEMPLATE_DIR'])
    proc = subprocess.Popen([*prefix, *map(str, args)], cwd=cwd, env=env,
                            stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
                            start_new_session=os.name != 'nt')
    try:
        stdout, _ = proc.communicate(input=input_data, timeout=remaining)
    except BaseException as error:
        # Kill the entire owned tree, not unrelated Git processes. Never clean the
        # temporary clone or report success while a child may still hold its pipes.
        cleanup_confirmed = True
        if os.name == 'nt':
            try:
                killed = subprocess.run(['taskkill', '/T', '/F', '/PID', str(proc.pid)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                cleanup_confirmed = killed.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                cleanup_confirmed = False
        else:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                cleanup_confirmed = proc.poll() is not None
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired as cleanup_error:
            raise BundleError('Git process cleanup unconfirmed') from cleanup_error
        if not cleanup_confirmed:
            raise BundleError('Git process cleanup unconfirmed') from None
        if isinstance(error, subprocess.TimeoutExpired):
            raise BundleError('Git deadline exceeded') from None
        raise
    if proc.returncode:
        raise BundleError('Git verification or local clone failed')
    return stdout


def entries(cwd, env):
    result = {}
    for record in git(cwd, env, 'ls-files', '--stage', '-z').split(b'\0'):
        if not record:
            continue
        meta, name = record.split(b'\t', 1)
        mode, oid, stage = meta.split(b' ')
        if stage != b'0':
            raise BundleError('unmerged tracked entry')
        path = os.fsdecode(name).replace('\\', '/')
        parts = PurePosixPath(path).parts
        if (not path or path.startswith('-') or path.startswith('/') or '\\' in os.fsdecode(name)
                or ':' in path or any(p in ('', '.', '..') for p in parts)):
            raise BundleError('unsafe tracked path')
        if (any(p in ('node_modules', 'output', '.ssh', '.aws') for p in parts)
                or any(p == '.env' or (p.startswith('.env.') and not p.endswith('.example'))
                       or p.lower() in ('.npmrc', '.pypirc', 'id_rsa')
                       or (re.fullmatch(r'(?:credentials?|secrets?)(?:\..+)?', p.lower())
                           and not (p == 'credentials' and path in SOURCE_CREDENTIAL_ROUTES))
                       or p.lower().endswith(('.pem', '.key')) for p in parts)):
            raise BundleError('tracked runtime or credential path')
        if mode not in (b'100644', b'100755'):
            raise BundleError('symlink, submodule or special tracked entry')
        result[path] = (0o755 if mode == b'100755' else 0o644, oid)
    if not result:
        raise BundleError('empty tracked source')
    return result


def snapshot(cwd, env, expected=None):
    if Path(os.fsdecode(git(cwd, env, 'rev-parse', '--show-toplevel').strip())).resolve() != cwd:
        raise BundleError('source must be a repository root')
    head = git(cwd, env, 'rev-parse', 'HEAD').decode('ascii').strip()
    if not COMMIT.fullmatch(head) or (expected and head != expected.lower()):
        raise BundleError('unexpected source HEAD')
    if git(cwd, env, 'status', '--porcelain=v1', '-uno', '-z'):
        raise BundleError('tracked source is not clean')
    return head, entries(cwd, env)


def preflight_source(cwd, env, tracked):
    directories = {'.git'}
    total = 0
    for name in tracked:
        directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != '.')
        if len(tracked) + len(directories) > MAX_ARCHIVE_MEMBERS:
            raise BundleError('too many archive entries')
    # Batch Git blob stats: the index identity and disk size must agree before
    # clone. A dirty worktree cannot silently spend beyond the source budget.
    oids = [oid for _, oid in tracked.values()]
    sizes = git(cwd, env, 'cat-file', '--batch-check=%(objectsize)',
                input_data=b'\n'.join(oids) + b'\n').splitlines()
    if len(sizes) != len(tracked):
        raise BundleError('Git blob stat mismatch')
    for (name, _), raw in zip(tracked.items(), sizes):
        try:
            size = int(raw)
        except ValueError as error:
            raise BundleError('Git blob stat mismatch') from error
        st = (cwd / name).lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_size != size:
            raise BundleError('tracked source size mismatch')
        total += size
        if total > MAX_ARCHIVE_BYTES:
            raise BundleError('source byte budget exceeded')


def add_file(tar, disk, name, mode):
    st = disk.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_ARCHIVE_BYTES:
        raise BundleError('unsafe source entry')
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = st.st_size, mode, 0
    with disk.open('rb') as stream:
        tar.addfile(info, stream)


def pack(clone, tracked, tar_path):
    directories = {'.git'}
    for name in tracked:
        directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != '.')
    metadata = []
    total = 0
    for root, dirs, files in os.walk(clone / '.git', followlinks=False):
        for directory in dirs:
            disk = Path(root) / directory
            if not stat.S_ISDIR(disk.lstat().st_mode):
                raise BundleError('unsafe Git metadata directory')
            directories.add(disk.relative_to(clone).as_posix())
        for filename in files:
            disk = Path(root) / filename
            name = disk.relative_to(clone).as_posix()
            if name == '.git/objects/info/alternates':
                raise BundleError('clone shares Git objects')
            st = disk.lstat()
            if not stat.S_ISREG(st.st_mode):
                raise BundleError('unsafe Git metadata file')
            metadata.append((disk, name, 0o644))
            total += st.st_size
            if total > MAX_ARCHIVE_BYTES or len(metadata) + len(tracked) + len(directories) > MAX_ARCHIVE_MEMBERS:
                raise BundleError('clone metadata budget exceeded')
    count = len(metadata) + len(tracked) + len(directories)
    if count > MAX_ARCHIVE_MEMBERS:
        raise BundleError('too many archive entries')
    for name in tracked:
        disk = clone / name
        st = disk.lstat()
        if not stat.S_ISREG(st.st_mode):
            raise BundleError('unsafe source entry')
        total += st.st_size
        if total > MAX_ARCHIVE_BYTES:
            raise BundleError('clone byte budget exceeded')
    for name in directories:
        if not stat.S_ISDIR((clone / name).lstat().st_mode):
            raise BundleError('unsafe directory')
    total = 0
    # GNU/PAX headers and padding are accounted separately from unpacked bytes.
    physical_limit = MAX_ARCHIVE_BYTES + MAX_ARCHIVE_MEMBERS * 1024 + 1024
    with tarfile.open(tar_path, 'w') as tar:
        for disk, name, mode in [*metadata, *[(clone / name, name, mode)
                                               for name, (mode, _) in sorted(tracked.items())]]:
            size = disk.lstat().st_size
            if total + size > MAX_ARCHIVE_BYTES:
                raise BundleError('archive byte budget exceeded')
            add_file(tar, disk, name, mode)
            total += size
            if tar.fileobj.tell() > physical_limit:
                raise BundleError('archive physical budget exceeded')
        for name in sorted(directories):
            info = tarfile.TarInfo(name + '/')
            info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, 0
            tar.addfile(info)
            if tar.fileobj.tell() > physical_limit:
                raise BundleError('archive physical budget exceeded')
    if tar_path.stat().st_size > physical_limit:
        raise BundleError('archive physical budget exceeded')
    return count


def prepare(source, output, expected):
    if str(source).startswith(('\\\\', '//')):
        raise BundleError('network source is not allowed')
    if not source.is_dir() or not output.parent.is_dir() or output.exists():
        raise BundleError('source/output missing or output already exists')
    source = source.resolve()
    output = output.absolute()
    actual_parent = output.parent.resolve()
    if source == actual_parent or source in actual_parent.parents:
        raise BundleError('output must be outside the repository')
    with tempfile.TemporaryDirectory(prefix='apollo-bundle-', dir=output.parent) as temp:
        owned = Path(temp)
        env = GitEnvironment({k: v for k, v in os.environ.items() if not k.startswith('GIT_')
                              and k not in ('MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL')})
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0', GIT_LFS_SKIP_SMUDGE='1',
                   GIT_TEMPLATE_DIR=str(owned / 'template'), XDG_CONFIG_HOME=str(owned / 'xdg'))
        (owned / 'template').mkdir()
        head, tracked = snapshot(source, env, expected)
        preflight_source(source, env, tracked)
        clone = owned / 'clone'
        git(owned, env, '-c', 'core.autocrlf=false', 'clone', '--no-local', '--depth=1', '--no-hardlinks',
            '--', str(source), str(clone))
        git(clone, env, 'remote', 'remove', 'origin')
        if (git(clone, env, 'rev-parse', 'HEAD').decode('ascii').strip() != head
                or git(clone, env, 'rev-parse', '--is-shallow-repository').strip() != b'true'
                or entries(clone, env) != tracked):
            raise BundleError('clone does not match source snapshot')
        if git(clone, env, 'hash-object', '-w', '-t', 'tree', '--stdin', input_data=b'').strip() != EMPTY_TREE.encode():
            raise BundleError('empty tree object mismatch')
        git(clone, env, 'cat-file', '-e', EMPTY_TREE + '^{tree}')
        tar_path = owned / 'bundle.tar'
        count = pack(clone, tracked, tar_path)
        if snapshot(source, env, head) != (head, tracked):
            raise BundleError('source changed while packaging')
        digest = hashlib.sha256()
        with tar_path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        size = tar_path.stat().st_size
        try:
            os.link(tar_path, output)  # Atomic create-if-absent; never overwrite.
        except FileExistsError as error:
            raise BundleError('output already exists') from error
        return dict(commit=head, sha256=digest.hexdigest(), bytes=size, entries=count,
                    path=str(output), scope='source-bundle-not-e2e')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path, help='local clean Git repository root')
    parser.add_argument('--output', required=True, type=Path, help='new tar outside source')
    parser.add_argument('--expected-commit', help='required HEAD, 40 hexadecimal digits')
    args = parser.parse_args()
    if args.expected_commit and not COMMIT.fullmatch(args.expected_commit):
        parser.error('--expected-commit must be 40 hexadecimal digits')
    try:
        print(json.dumps(prepare(args.source, args.output, args.expected_commit)))
    except (BundleError, OSError, ValueError) as error:
        print('bundle preparation failed: ' + (str(error) if isinstance(error, BundleError)
                                                else 'local file or Git error'), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
