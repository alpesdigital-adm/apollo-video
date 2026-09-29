"""Local, offline integration tests for the source bundle producer."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
import importlib.util


CLI = Path(__file__).resolve().parents[2] / 'scripts/ops/digitalocean-bootstrap/prepare_bundle.py'
SCRATCH = Path(os.environ['TMPDIR'])
spec = importlib.util.spec_from_file_location('prepare_bundle', CLI)
if spec is None or spec.loader is None:
    raise RuntimeError('bundle producer module unavailable')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class PrepareBundleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='test-apollo-bundle-', dir=SCRATCH)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'source'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'core.autocrlf', 'false')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Bundle Test')
        (self.repo / 'readme.txt').write_text('fixture source\n')
        self.git('add', 'readme.txt')
        self.git('commit', '-qm', 'fixture initial')
        self.commit = self.git('rev-parse', 'HEAD').stdout.strip()
        self.output = self.root / 'source.tar'

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, capture_output=True,
                              text=True, check=True)

    def run_cli(self, *args, output=None, source=None):
        env = os.environ.copy()
        env.update({'TMPDIR': str(SCRATCH), 'TEMP': str(SCRATCH),
                    'TMP': str(SCRATCH), 'PYTHONDONTWRITEBYTECODE': '1'})
        return subprocess.run([sys.executable, str(CLI), '--source', str(source or self.repo),
                               '--output', str(output or self.output), *args],
                              capture_output=True, text=True, env=env)

    def test_bundle_contains_shallow_git_and_tracked_source_only(self):
        (self.repo / 'owner-untracked.txt').write_text('keep outside bundle')
        (self.repo / '.env').write_text('untracked local runtime value')
        (self.repo / 'node_modules').mkdir()
        (self.repo / 'node_modules' / 'ignored').write_text('local only')
        (self.repo / 'output').mkdir()
        (self.repo / 'output' / 'ignored').write_text('local only')
        self.assertEqual(self.git('status', '--porcelain=v1', '-uno').stdout, '')
        self.assertEqual(self.git('-c', 'core.autocrlf=false', 'status', '--porcelain=v1', '-uno').stdout, '')
        result = self.run_cli('--expected-commit', self.commit)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt['commit'], self.commit)
        self.assertEqual(receipt['scope'], 'source-bundle-not-e2e')
        data = self.output.read_bytes()
        self.assertEqual(receipt['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(receipt['bytes'], len(data))
        with tarfile.open(self.output) as archive:
            names = archive.getnames()
            self.assertEqual(receipt['entries'], len(names))
            self.assertIn('readme.txt', names)
            self.assertIn('.git/HEAD', names)
            self.assertNotIn('owner-untracked.txt', names)
            self.assertNotIn('.env', names)
            self.assertTrue(all(n != 'node_modules' and not n.startswith('node_modules/')
                                and n != 'output' and not n.startswith('output/') for n in names))
            self.assertTrue(all(m.isfile() or m.isdir() for m in archive.getmembers()))
            extracted = self.root / 'extracted'
            archive.extractall(extracted, filter='data')
        self.assertEqual(subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=extracted,
                                        capture_output=True, text=True, check=True).stdout.strip(), self.commit)
        self.assertEqual(subprocess.run(['git', 'rev-parse', '--is-shallow-repository'], cwd=extracted,
                                        capture_output=True, text=True, check=True).stdout.strip(), 'true')
        subprocess.run(['git', 'cat-file', '-e', '4b825dc642cb6eb9a060e54bf8d69288fbee4904^{tree}'],
                       cwd=extracted, capture_output=True, check=True)
        self.assertTrue((self.repo / 'owner-untracked.txt').exists())

    def test_dirty_tracked_worktree_and_index_are_rejected(self):
        (self.repo / 'readme.txt').write_text('edited')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.output.exists())
        self.git('add', 'readme.txt')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_overwritten(self):
        self.output.write_bytes(b'owner artifact')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(self.output.read_bytes(), b'owner artifact')

    def test_wrong_expected_commit_is_rejected(self):
        self.assertNotEqual(self.run_cli('--expected-commit', '0' * 40).returncode, 0)
        self.assertFalse(self.output.exists())

    def test_invalid_expected_commit_is_rejected(self):
        self.assertNotEqual(self.run_cli('--expected-commit', 'abc').returncode, 0)
        self.assertFalse(self.output.exists())

    def test_output_inside_source_and_non_root_source_are_rejected(self):
        self.assertNotEqual(self.run_cli(output=self.repo / 'bundle.tar').returncode, 0)
        self.assertFalse((self.repo / 'bundle.tar').exists())
        subdir = self.repo / 'nested'
        subdir.mkdir()
        self.assertNotEqual(self.run_cli(source=subdir).returncode, 0)
        self.assertFalse(self.output.exists())

    def test_output_directory_alias_into_source_is_rejected(self):
        alias = self.root / 'alias'
        try:
            alias.symlink_to(self.repo, target_is_directory=True)
        except OSError as error:
            if os.name != 'nt':
                self.skipTest(f'directory symlinks unavailable: {error.__class__.__name__}')
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(alias), str(self.repo)],
                           capture_output=True, check=True)
        result = self.run_cli(output=alias / 'bundle.tar')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.repo / 'bundle.tar').exists())

    def test_tracked_runtime_env_is_rejected_but_public_examples_are_allowed(self):
        (self.repo / '.env.production').write_text('fixture secret path')
        self.git('add', '.env.production')
        self.git('commit', '-qm', 'fixture env')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.output.exists())
        self.git('rm', '-q', '.env.production')
        (self.repo / '.env.example').write_text('PUBLIC_PLACEHOLDER=fixture\n')
        (self.repo / '.env.local.example').write_text('PUBLIC_PLACEHOLDER=fixture\n')
        self.git('add', '.env.example', '.env.local.example')
        self.git('commit', '-qm', 'fixture examples')
        self.assertEqual(self.git('status', '--porcelain=v1', '-uno').stdout, '')
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(self.output) as archive:
            self.assertIn('.env.example', archive.getnames())
            self.assertIn('.env.local.example', archive.getnames())

    def test_executable_bit_comes_from_git_index(self):
        self.git('config', 'core.filemode', 'false')
        self.git('update-index', '--chmod=+x', 'readme.txt')
        self.git('commit', '-qm', 'fixture executable')
        self.assertEqual(self.git('status', '--porcelain=v1', '-uno').stdout, '')
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(self.output) as archive:
            self.assertEqual(archive.getmember('readme.txt').mode & 0o111, 0o111)

    def test_tracked_symlink_is_rejected(self):
        # A committed symlink needs an existing blob but no Windows symlink privilege.
        blob = self.git('hash-object', '-w', '--stdin').stdout.strip()  # empty target blob
        self.git('update-index', '--add', '--cacheinfo', f'120000,{blob},link')
        self.git('commit', '-qm', 'fixture symlink')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_hanging_command_is_killed_and_reaped_without_publishing(self):
        marker = self.root / 'late-marker'
        stub = ('import time, pathlib; time.sleep(5); pathlib.Path(%r).write_text("leak")' % str(marker))
        started = time.monotonic()
        with self.assertRaises(bundle.BundleError) as caught:
            bundle.git(self.repo, os.environ.copy(), 'ignored', timeout=0.1,
                       command_prefix=(sys.executable, '-c', stub))
        self.assertLess(time.monotonic() - started, 4)
        self.assertNotIn('late-marker', str(caught.exception))
        time.sleep(0.3)
        self.assertFalse(marker.exists())
        self.assertFalse(self.output.exists())

    def test_hanging_command_kills_owned_descendant(self):
        marker = self.root / 'descendant-marker'
        child = 'import time, pathlib; time.sleep(1); pathlib.Path(%r).write_text("leak")' % str(marker)
        stub = 'import subprocess, sys, time; subprocess.Popen([sys.executable, "-c", %r]); time.sleep(5)' % child
        with self.assertRaises(bundle.BundleError):
            bundle.git(self.repo, os.environ.copy(), 'ignored', timeout=0.2,
                       command_prefix=(sys.executable, '-c', stub))
        time.sleep(1.2)
        self.assertFalse(marker.exists())

    def test_exhausted_total_git_deadline_does_not_start_command(self):
        env = bundle.GitEnvironment(os.environ.copy())
        env.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(bundle.BundleError, 'deadline'):
            bundle.git(self.repo, env, timeout=1,
                       command_prefix=(sys.executable, '-c', 'raise RuntimeError("started")'))

    def test_source_budget_rejects_before_clone_without_output_or_temp(self):
        (self.repo / 'large.bin').write_bytes(b'x' * 32)
        self.git('add', 'large.bin')
        self.git('commit', '-qm', 'fixture large')
        with patch.object(bundle, 'MAX_ARCHIVE_BYTES', 20):
            with self.assertRaises(bundle.BundleError):
                bundle.prepare(self.repo, self.output, None)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('apollo-bundle-*')), [])

    def test_source_entry_budget_counts_directories_before_clone(self):
        (self.repo / 'a').mkdir()
        (self.repo / 'a' / 'small').write_text('x')
        self.git('add', 'a/small')
        self.git('commit', '-qm', 'fixture directory')
        with patch.object(bundle, 'MAX_ARCHIVE_MEMBERS', 2):
            with self.assertRaises(bundle.BundleError):
                bundle.prepare(self.repo, self.output, None)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('apollo-bundle-*')), [])

    def test_git_metadata_budget_is_checked_before_tar_creation(self):
        with patch.object(bundle, 'MAX_ARCHIVE_BYTES', 100):
            with self.assertRaises(bundle.BundleError):
                bundle.prepare(self.repo, self.output, None)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('apollo-bundle-*')), [])

    def test_pack_enforces_budget_during_write_and_removes_temporary(self):
        original = bundle.add_file
        def lower_budget_after_first(tar, disk, name, mode):
            original(tar, disk, name, mode)
            if name == '.git/HEAD':
                setattr(bundle, 'MAX_ARCHIVE_BYTES', 1)
        with patch.object(bundle, 'add_file', side_effect=lower_budget_after_first), \
                patch.object(bundle, 'MAX_ARCHIVE_BYTES', 1024 * 1024):
            with self.assertRaises(bundle.BundleError):
                bundle.prepare(self.repo, self.output, None)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob('apollo-bundle-*')), [])


if __name__ == '__main__':
    unittest.main()
