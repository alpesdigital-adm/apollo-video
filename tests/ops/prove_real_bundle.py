#!/usr/bin/env python3
"""Offline CI readback of a real source bundle; never starts the remote guard runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/ops/digitalocean-bootstrap'))
from prepare_bundle import SOURCE_CREDENTIAL_ROUTES
from remote_guard import safe_extract


def git(source, *args):
    return subprocess.run(['git', '-c', 'protocol.allow=never', '-C', str(source), *args],
                          check=True, capture_output=True, text=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--expected-commit', required=True)
    args = parser.parse_args()
    receipt = json.loads(args.receipt.read_text(encoding='utf-8'))
    if (receipt.get('commit') != args.expected_commit
            or receipt.get('scope') != 'source-bundle-not-e2e'
            or receipt.get('path') != str(args.archive)):
        raise ValueError('receipt identity mismatch')
    digest = hashlib.sha256()
    with args.archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != receipt.get('sha256') or args.archive.stat().st_size != receipt.get('bytes'):
        raise ValueError('receipt archive mismatch')
    with tarfile.open(args.archive, 'r:') as archive:
        names = [member.name for member in archive]
    if len(names) != receipt.get('entries') or not SOURCE_CREDENTIAL_ROUTES.issubset(names):
        raise ValueError('archive entries or required routes missing')
    with tempfile.TemporaryDirectory(prefix='apollo-real-bundle-', dir=args.archive.parent) as temporary:
        source = Path(temporary) / 'source'
        safe_extract(args.archive, source)
        if (git(source, 'rev-parse', 'HEAD') != args.expected_commit
                or git(source, 'rev-parse', '--is-shallow-repository') != 'true'
                or git(source, 'status', '--porcelain=v1', '--untracked-files=normal')):
            raise ValueError('extracted Git source identity mismatch')
        if not all((source / route).is_file() for route in SOURCE_CREDENTIAL_ROUTES):
            raise ValueError('extracted source routes missing')
    print(json.dumps({key: receipt[key] for key in ('commit', 'sha256', 'bytes', 'entries', 'scope')},
                     sort_keys=True))


if __name__ == '__main__':
    main()
