"""Pure config/fixed-init-stop guards; no warden import/CDLL/process/network/privilege.

Execute actual reviewed Python AST functions with controlled identity/fd/clock
facts. STOP delivery and Linux UID/caps/kernel behavior require the real gate.
The JavaScript environment list is read as literal source, never executed.
"""
import ast
import errno
import hashlib
from copy import deepcopy
import os
from pathlib import Path
import re
import stat
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
WARDEN = ROOT / "scripts/validation/perception_namespace_warden.py"
LAUNCHER = ROOT / "scripts/validation/run-perception-ci-namespace.mjs"


def configuration_contract():
    tree = ast.parse(WARDEN.read_text(encoding="utf-8"), filename=str(WARDEN))
    constants = {"ABI", "SUITES", "CONTROLLED_FAULTS", "ENV_NAMES"}
    functions = {"require", "validate_config"}
    selected, found = [], set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in constants:
                # Only literal closed sets/strings, never module side effects.
                expression = node.value
                if isinstance(expression, ast.Call):
                    if not (isinstance(expression.func, ast.Name) and expression.func.id == "frozenset" and
                            len(expression.args) == 1 and not expression.keywords):
                        raise AssertionError("nonliteral configuration constant")
                    expression = expression.args[0]
                ast.literal_eval(expression)
                selected.append(node); found.add(name)
        elif isinstance(node, ast.FunctionDef) and node.name in functions:
            if node.decorator_list:
                raise AssertionError("configuration function gained a decorator")
            selected.append(node); found.add(node.name)
    if found != constants | functions or len(selected) != 6:
        raise AssertionError("configuration contract declarations changed")
    expected_globals = {"require": {"RuntimeError"}, "validate_config": {
        "require", "ABI", "re", "os", "SUITES", "CONTROLLED_FAULTS", "ENV_NAMES", "time",
        "type", "dict", "set", "all", "str", "len", "int"}}
    for node in selected:
        if not isinstance(node, ast.FunctionDef):
            continue
        bound = {argument.arg for argument in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)}
        bound |= {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store)}
        used = {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
        if used - bound != expected_globals[node.name]:
            raise AssertionError("configuration validator globals changed: " + node.name)
    namespace = {"__builtins__": {"frozenset": frozenset, "RuntimeError": RuntimeError, "type": type,
        "dict": dict, "set": set, "all": all, "str": str, "len": len, "int": int},
        "re": re, "time": SimpleNamespace(time=lambda: 1000),
        "os": SimpleNamespace(path=SimpleNamespace(isabs=os.path.isabs, basename=os.path.basename,
            isfile=lambda _path: True), access=lambda _path, _mode: True, X_OK=1)}
    isolated = ast.Module(body=selected, type_ignores=[])
    exec(compile(isolated, str(WARDEN), "exec"), namespace)
    return namespace


class NamespaceConfiguration(unittest.TestCase):
    def setUp(self):
        self.contract = configuration_contract()
        self.config = {"abi": self.contract["ABI"], "runId": "perception-namespace-controlled-config",
            "uid": 600, "gid": 700, "node": str((ROOT / "node").resolve()),
            "suite": "tests/v2/tesseract-ocr-video-adapter.integration.mjs", "pattern": None,
            "environment": {"GITHUB_SHA": "a" * 40, "APOLLO_PERCEPTION_PIDFD_ROOT": "/private/owned-pidfd",
                "APOLLO_PERCEPTION_CONSUMER_RUN_ID": "perception-consumer-controlled"},
            "deadlineAt": 1450000, "innerDeadlineAt": 1420000,
            "sourceCommit": "a" * 40, "controlledFault": None}

    def test_closed_allowlists_match_javascript_exactly_and_include_registry_binding(self):
        source = LAUNCHER.read_text(encoding="utf-8")
        match = re.search(r"const NORMAL_ENVIRONMENT = \[([^\]]*)\]", source, re.S)
        self.assertIsNotNone(match)
        names = re.findall(r"'([A-Z][A-Z0-9_]*)'", match.group(1))
        remainder = re.sub(r"'[A-Z][A-Z0-9_]*'|[\s,]", "", match.group(1))
        self.assertEqual(remainder, "", "allowlist must remain literal, without spread/wildcard")
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(frozenset(names), self.contract["ENV_NAMES"])
        self.assertIn("APOLLO_PERCEPTION_PIDFD_ROOT", names)
        self.assertIn("APOLLO_PERCEPTION_CONSUMER_RUN_ID", names)
        self.assertIs(self.contract["validate_config"](self.config), self.config)

    def test_unknown_environment_names_fail_without_wildcards(self):
        for name in ("ARBITRARY_SECRET", "NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH",
                     "APOLLO_PERCEPTION_PIDFD_ROOT_EXTRA", "APOLLO_PERCEPTION_CONSUMER_RUN_ID_EXTRA"):
            with self.subTest(name=name):
                config = deepcopy(self.config); config["environment"][name] = "controlled"
                with self.assertRaisesRegex(RuntimeError, "environment is outside the launch allowlist"):
                    self.contract["validate_config"](config)

    def test_allowed_names_still_reject_nonstring_nul_and_unbounded_values(self):
        for name in ("APOLLO_PERCEPTION_PIDFD_ROOT", "APOLLO_PERCEPTION_CONSUMER_RUN_ID"):
            for value in (None, 1, True, [], {}, b"controlled", "before\0after", "x" * 8193):
                with self.subTest(name=name, value_type=type(value).__name__):
                    config = deepcopy(self.config); config["environment"][name] = value
                    with self.assertRaisesRegex(RuntimeError, "environment is outside the launch allowlist"):
                        self.contract["validate_config"](config)
        for value in (None, [], "not-an-environment"):
            config = deepcopy(self.config); config["environment"] = value
            with self.assertRaisesRegex(RuntimeError, "environment is outside the launch allowlist"):
                self.contract["validate_config"](config)


def cgroup_configuration_contract():
    path = ROOT / "scripts/validation/perception-consumer-cgroup.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    selected = []
    functions = {"require", "validate_environment", "validate_consumer"}
    expected_globals = {"require": {"RuntimeError"},
        "validate_environment": {"require", "type", "dict", "set", "ENV_NAMES", "all", "str", "sum", "len"},
        "validate_consumer": {"require", "type", "dict", "set", "str", "list", "all", "len"}}
    found = set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "ENV_NAMES":
            value = node.value
            if not (isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "frozenset"
                    and len(value.args) == 1 and not value.keywords):
                raise AssertionError("cgroup environment must remain literal")
            ast.literal_eval(value.args[0]); selected.append(node); found.add("ENV_NAMES")
        elif isinstance(node, ast.FunctionDef) and node.name in functions:
            if node.decorator_list:
                raise AssertionError("cgroup validator gained a decorator")
            bound = {argument.arg for argument in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)}
            bound |= {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store)}
            used = {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
            if used - bound != expected_globals[node.name]:
                raise AssertionError("cgroup validator globals changed: " + node.name)
            selected.append(node); found.add(node.name)
    if found != functions | {"ENV_NAMES"} or len(selected) != 4:
        raise AssertionError("cgroup contract declarations changed")
    namespace = {"__builtins__": {name: value for name, value in (
        ("frozenset", frozenset), ("RuntimeError", RuntimeError), ("type", type), ("dict", dict),
        ("set", set), ("all", all), ("str", str), ("list", list), ("len", len), ("sum", sum))}}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


class CgroupConfiguration(unittest.TestCase):
    def setUp(self):
        self.contract = cgroup_configuration_contract()

    def test_actual_closed_environment_matches_node_owner(self):
        source = (ROOT / "scripts/validation/perception-consumer-cgroup.mjs").read_text(encoding="utf-8")
        match = re.search(r"export const CGROUP_ENVIRONMENT = Object.freeze\(\[([^\]]*)\]\)", source, re.S)
        self.assertIsNotNone(match)
        names = re.findall(r"'([A-Z][A-Z0-9_]*)'", match.group(1))
        self.assertEqual(re.sub(r"'[A-Z][A-Z0-9_]*'|[\s,]", "", match.group(1)), "")
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(frozenset(names), self.contract["ENV_NAMES"])
        for name in ("APOLLO_PERCEPTION_CGROUP_SCOPE", "APOLLO_PERCEPTION_PIDFD_ROOT", "APOLLO_PERCEPTION_CONSUMER_RUN_ID"):
            self.assertIn(name, names)
            self.contract["validate_environment"]({name: "controlled"})

    def test_arbitrary_names_types_nul_and_aggregate_bytes_are_rejected(self):
        for name in ("NODE_OPTIONS", "LD_PRELOAD", "PYTHONPATH", "ARBITRARY", "APOLLO_PERCEPTION_CGROUP_SCOPE_EXTRA"):
            with self.assertRaisesRegex(RuntimeError, "invalid normal consumer environment"):
                self.contract["validate_environment"]({name: "controlled"})
        for value in (None, True, 1, [], {}, "a\0b"):
            with self.assertRaisesRegex(RuntimeError, "invalid normal consumer environment"):
                self.contract["validate_environment"]({"APOLLO_PERCEPTION_CGROUP_SCOPE": value})
        with self.assertRaisesRegex(RuntimeError, "environment bound"):
            self.contract["validate_environment"]({"HOME": "x" * 131073})

    def test_consumer_and_faults_are_fixed_not_exec_rpc(self):
        validate = self.contract["validate_consumer"]
        validate({"mode": "unit", "args": []})
        validate({"mode": "dashboard", "args": []})
        validate({"mode": "acquisition", "args": []})
        for kind in ("wait", "setsid-reparent", "zombie", "member-exit", "guardian-stop-owner-death"):
            validate({"mode": "fixture", "args": [kind]})
        validate({"mode": "namespace", "args": ["tests/v2/prisma-face-producer.integration.mjs", "publish-race|face control"]})
        for value in ({"mode": "exec", "args": ["sh"]}, {"mode": "unit", "args": ["arbitrary"]},
                      {"mode": "dashboard", "args": ["arbitrary"]}, {"mode": "acquisition", "args": ["https://arbitrary.invalid"]},
                      {"mode": "fixture", "args": ["arbitrary"]}, {"mode": "fixture", "args": ["wait", "extra"]},
                      {"mode": "namespace", "args": ["tests/v2/prisma-face-producer.integration.mjs"]},
                      {"mode": "unit", "args": [], "path": "arbitrary"}):
            with self.assertRaises(RuntimeError):
                validate(value)


def init_stop_contract(world):
    # Real reviewed functions only. Never import the CDLL/fork/entry-point module.
    tree = ast.parse(WARDEN.read_text(encoding="utf-8"), filename=str(WARDEN))
    functions = {"require", "remaining", "key", "init_namespace_pids", "mint_init_stop_anchor",
                 "revalidate_init_stop_anchor", "stop_minted_init", "guardian_product_gate", "pidfd_signal"}
    constants = {"ABI", "TERMINAL", "STATUS_LIMIT"}
    selected, found = [], set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id in constants:
            ast.literal_eval(node.value)
            selected.append(node); found.add(node.targets[0].id)
        elif isinstance(node, ast.FunctionDef) and node.name in functions:
            if node.decorator_list:
                raise AssertionError("stop helper gained a decorator")
            if any(isinstance(item, (ast.Import, ast.ImportFrom)) for item in ast.walk(node)):
                raise AssertionError("stop helper gained an import")
            selected.append(node); found.add(node.name)
    if found != functions | constants:
        raise AssertionError("fixed stop contract declarations changed")
    # Execute the SAME descriptor-closing finally loop used by host_main.
    host = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "host_main")
    host_try = next(node for node in host.body if isinstance(node, ast.Try))
    closing = [node for node in host_try.finalbody if isinstance(node, ast.For) and
               isinstance(node.iter, ast.Name) and node.iter.id == "descriptors"]
    if len(closing) != 1:
        raise AssertionError("host descriptor finally changed")
    wrapper = ast.parse("def close_host_descriptors(descriptors):\n    pass").body[0]
    wrapper.body = [deepcopy(closing[0])]
    selected.append(wrapper)
    builtins = {name: value for name, value in (("RuntimeError", RuntimeError), ("BaseException", BaseException),
        ("OSError", OSError), ("type", type), ("dict", dict), ("all", all), ("int", int),
        ("len", len), ("min", min), ("str", str), ("hasattr", hasattr), ("getattr", getattr))}
    allowed = functions | constants | set(builtins) | {"os", "signal", "time", "select", "re", "hashlib", "errno", "identity", "bounded_read", "packet_write"}
    for node in selected:
        if not isinstance(node, ast.FunctionDef):
            continue
        bound = {argument.arg for argument in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)}
        bound |= {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Store)}
        bound |= {item.name for item in ast.walk(node) if isinstance(item, ast.ExceptHandler) and item.name is not None}
        used = {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
        if not used - bound <= allowed:
            raise AssertionError("unreviewed stop helper globals: " + node.name)
    namespace = {"__builtins__": builtins, "re": re, "hashlib": hashlib, "errno": errno,
        "time": SimpleNamespace(monotonic=lambda: world.now, sleep=world.sleep),
        "select": SimpleNamespace(select=world.select), "identity": world.identity, "bounded_read": world.bounded_read,
        "os": SimpleNamespace(pidfd_open=world.pidfd_open, open=world.open_namespace, close=world.close,
            fstat=world.fstat, readlink=world.readlink, getpid=lambda: 7000, read=world.read_ack,
            O_RDONLY=0, O_CLOEXEC=0x80000),
        "signal": SimpleNamespace(SIGSTOP=19, SIGTERM=15, SIGKILL=9, pidfd_send_signal=world.send_signal),
        "packet_write": world.packet_write}
    # packet_write is reviewed and controlled, never a process/network action.
    exec(compile(ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[])), str(WARDEN), "exec"), namespace)
    return namespace


class InitStopWorld:
    def __init__(self):
        self.now, self.after_drop, self.signaled = 10.0, False, False
        self.ack, self.ack_ready, self.signal_error = b"G", True, None
        self.states, self.events, self.descriptors, self.closed = ["S", "S", "T", "T"], [], [], []
        self.init = {"pid": 9000, "starttime": "900", "ppid": 8000, "state": "S"}
        self.unshare = {"pid": 8000, "starttime": "800", "ppid": 7000, "state": "S"}
        self.identities = {9000: self.init, 8000: self.unshare}
        self.pids, self.namespace_inode, self.pidfd_inode = "9000 1", 100, 701
        self.birth = {"hostIdentity": deepcopy(self.init), "namespace": {"pid": "pid:[100]", "mount": "mnt:[200]"}}
        self.contract = init_stop_contract(self)

    def identity(self, pid):
        self.events.append(("identity", pid))
        value = self.identities.get(pid)
        if value is None:
            return None
        value = deepcopy(value)
        if pid == 9000 and self.signaled:
            value["state"] = self.states.pop(0) if self.states else "S"
        return value

    def bounded_read(self, path, maximum):
        if path != "/proc/9000/status":
            raise AssertionError("unexpected proc source")
        self.events.append(("status", maximum))
        return ("NSpid:\t" + self.pids + "\n").encode("ascii")

    def pidfd_open(self, pid, flags):
        if pid != 9000 or flags != 0:
            raise AssertionError("unexpected pidfd target")
        self.events.append(("pidfd-open", pid))
        return 71

    def open_namespace(self, path, flags):
        if path != "/proc/9000/ns/pid" or flags != 0x80000 or self.after_drop:
            raise AssertionError("namespace token must be opened before drop")
        self.events.append(("namespace-open", flags))
        return 72

    def fstat(self, descriptor):
        if descriptor not in (71, 72) or descriptor in self.closed:
            raise OSError(errno.EBADF, "controlled closed token")
        return SimpleNamespace(st_dev=7 if descriptor == 71 else 9,
                               st_ino=self.pidfd_inode if descriptor == 71 else self.namespace_inode)

    def readlink(self, path):
        if self.after_drop:
            raise AssertionError("no root namespace readlink after drop")
        return {"/proc/9000/ns/pid": "pid:[100]", "/proc/self/ns/pid": "pid:[99]",
                "/proc/9000/ns/mnt": "mnt:[200]", "/proc/self/ns/mnt": "mnt:[199]"}[path]

    def read_ack(self, descriptor, size):
        if (descriptor, size) != (0, 64):
            raise AssertionError("unexpected gate read")
        self.events.append(("ack", self.ack))
        return self.ack

    def select(self, reads, writes, errors, timeout):
        if reads != [0] or writes or errors or timeout > 5:
            raise AssertionError("unexpected gate wait")
        return ([0] if self.ack_ready else [], [], [])

    def send_signal(self, descriptor, requested, info, flags):
        if (descriptor, requested, info, flags) != (71, 19, None, 0):
            raise AssertionError("only fixed STOP on retained own pidfd")
        self.events.append(("signal", descriptor, requested))
        if self.signal_error is not None:
            raise self.signal_error
        self.signaled = True

    def sleep(self, seconds):
        self.events.append(("sleep", seconds))
        self.now += seconds

    def packet_write(self, descriptor, document, deadline):
        self.events.append(("release", descriptor, document, deadline))

    def close(self, descriptor):
        self.events.append(("close", descriptor)); self.closed.append(descriptor)

    def mint(self):
        return self.contract["mint_init_stop_anchor"](self.init, self.birth, self.unshare, self.descriptors, 50)

    def gate(self, anchor, fault="init-stop", execution_deadline=40):
        report = {}
        try:
            self.contract["guardian_product_gate"]({"controlledFault": fault, "runId": "controlled-init-stop"},
                report, anchor, 4, execution_deadline, 50)
        finally:
            self.contract["close_host_descriptors"](self.descriptors)
        return report


class NamespaceInitStop(unittest.TestCase):
    def stopped_gate(self, world, anchor, execution_deadline=40):
        report = {}
        try:
            world.contract["guardian_product_gate"]({"controlledFault": "init-stop", "runId": "controlled-init-stop"},
                report, anchor, 4, execution_deadline, 50)
        finally:
            world.contract["close_host_descriptors"](world.descriptors)
            self.report = report

    def test_ack_precedes_fixed_stop_and_observed_T_with_no_product_release(self):
        world = InitStopWorld(); anchor = world.mint(); world.after_drop = True
        with self.assertRaisesRegex(RuntimeError, "controlled init stop requires namespace containment"):
            self.stopped_gate(world, anchor)
        self.assertTrue(self.report["faultEvidence"]["launcherAckObserved"])
        self.assertTrue(self.report["faultEvidence"]["stopAccepted"])
        self.assertTrue(self.report["faultEvidence"]["stopObserved"])
        self.assertIn(self.report["faultEvidence"]["observedIdentity"]["state"], ("T", "t"))
        self.assertFalse(self.report["faultEvidence"]["nodeGateReleased"])
        self.assertLess(next(i for i, item in enumerate(world.events) if item[0] == "ack"),
                        next(i for i, item in enumerate(world.events) if item[0] == "signal"))
        self.assertFalse(any(item[0] == "release" for item in world.events))
        self.assertEqual(world.closed, [71, 72])

    def test_wrong_or_missing_ACK_blocks_signal_and_release_and_closes_tokens(self):
        for ready, ack in ((True, b"X"), (False, b"G")):
            with self.subTest(ready=ready):
                world = InitStopWorld(); anchor = world.mint(); world.after_drop = True
                world.ack_ready, world.ack = ready, ack
                with self.assertRaises(RuntimeError):
                    self.stopped_gate(world, anchor)
                self.assertFalse(any(item[0] in ("signal", "release") for item in world.events))
                self.assertFalse(self.report["faultEvidence"]["stopObserved"])
                self.assertEqual(world.closed, [71, 72])

    def test_host_PID1_is_denied_before_open_or_signal(self):
        world = InitStopWorld(); world.init["pid"] = world.birth["hostIdentity"]["pid"] = 1
        try:
            with self.assertRaisesRegex(RuntimeError, "invalid minted init host identity"):
                world.mint()
        finally:
            world.contract["close_host_descriptors"](world.descriptors)
        self.assertEqual(world.descriptors, [])
        self.assertFalse(any(item[0] in ("pidfd-open", "namespace-open", "signal", "release") for item in world.events))

    def test_recycled_parent_birth_namespace_and_fd_token_mismatch_fail_without_STOP(self):
        mutations = [("recycled", lambda world, anchor: world.init.update(starttime="901")),
                     ("parent", lambda world, anchor: world.init.update(ppid=8001)),
                     ("unshare-recycled", lambda world, anchor: world.unshare.update(starttime="801")),
                     ("birth", lambda world, anchor: anchor["birthIdentity"].update(starttime="902")),
                     ("namespace", lambda world, anchor: setattr(world, "pids", "9000 2")),
                     ("namespace-inode", lambda world, anchor: setattr(world, "namespace_inode", 101)),
                     ("namespace-descriptor", lambda world, anchor: anchor.update(namespaceFd=71)),
                     ("pidfd-descriptor", lambda world, anchor: anchor.update(pidfd=72)),
                     ("pidfd-token", lambda world, anchor: setattr(world, "pidfd_inode", 702))]
        for label, mutate in mutations:
            with self.subTest(case=label):
                world = InitStopWorld(); anchor = world.mint(); world.after_drop = True; mutate(world, anchor)
                with self.assertRaises(RuntimeError):
                    self.stopped_gate(world, anchor)
                self.assertFalse(self.report["faultEvidence"]["stopAttempted"])
                self.assertFalse(self.report["faultEvidence"]["stopObserved"])
                self.assertFalse(any(item[0] in ("signal", "release") for item in world.events))
                self.assertEqual(world.closed, [71, 72])

    def test_parent_validation_failure_after_pidfd_open_closes_registered_token(self):
        world = InitStopWorld(); world.unshare["ppid"] = 7001
        try:
            with self.assertRaisesRegex(RuntimeError, "parent or identity changed after pidfd open"):
                world.mint()
        finally:
            world.contract["close_host_descriptors"](world.descriptors)
        self.assertEqual(world.closed, [71])
        self.assertEqual(world.descriptors, [71])
        self.assertFalse(any(item[0] in ("namespace-open", "signal", "release") for item in world.events))

    def test_namespace_validation_failure_after_open_closes_both_registered_tokens(self):
        world = InitStopWorld(); world.namespace_inode = 101
        try:
            with self.assertRaisesRegex(RuntimeError, "namespace token inode mismatch"):
                world.mint()
        finally:
            world.contract["close_host_descriptors"](world.descriptors)
        self.assertEqual(world.closed, [71, 72])
        self.assertEqual(world.descriptors, [71, 72], "both were registered before the failing guard")

    def test_EPERM_is_attributed_not_observed_and_no_release(self):
        world = InitStopWorld(); anchor = world.mint(); world.after_drop = True
        world.signal_error = OSError(errno.EPERM, "controlled permission failure")
        with self.assertRaises(OSError) as error:
            self.stopped_gate(world, anchor)
        self.assertEqual(error.exception.errno, errno.EPERM)
        evidence = self.report["faultEvidence"]
        self.assertTrue(evidence["stopAttempted"]); self.assertFalse(evidence["stopAccepted"])
        self.assertFalse(evidence["stopObserved"]); self.assertEqual(evidence["failureStage"], "signal")
        self.assertEqual(evidence["error"]["errno"], errno.EPERM)
        self.assertEqual(evidence["error"]["messageSha256"], hashlib.sha256(str(error.exception).encode()).hexdigest())
        self.assertNotIn("message", evidence["error"])
        self.assertFalse(any(item[0] == "release" for item in world.events)); self.assertEqual(world.closed, [71, 72])

    def test_accepted_signal_without_T_and_expired_deadline_do_not_release_or_renew(self):
        for expired in (False, True):
            with self.subTest(expired=expired):
                world = InitStopWorld(); anchor = world.mint(); world.after_drop = True; world.states = []
                with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
                    self.stopped_gate(world, anchor, execution_deadline=10 if expired else 10.25)
                self.assertFalse(any(item[0] == "release" for item in world.events))
                self.assertEqual(world.closed, [71, 72])
                if not expired:
                    evidence = self.report["faultEvidence"]
                    self.assertTrue(evidence["stopAccepted"]); self.assertFalse(evidence["stopObserved"])
                    self.assertEqual(evidence["stopDeadlineMonotonic"], 10.25)
                    self.assertEqual(sum(item[0] == "signal" for item in world.events), 1)

    def test_normal_gate_releases_only_after_ACK_and_generic_containment_still_refuses_STOP(self):
        world = InitStopWorld(); anchor = world.mint(); world.after_drop = True
        world.gate(anchor, fault=None)
        self.assertEqual([item[0] for item in world.events if item[0] in ("ack", "signal", "release")], ["ack", "release"])
        with self.assertRaisesRegex(RuntimeError, "unsupported containment signal"):
            world.contract["pidfd_signal"](world.init, 19, 50)
        self.assertFalse(any(item[0] == "signal" for item in world.events))


def carrier_diagnostic_contract(world):
    tree = ast.parse(WARDEN.read_text(encoding="utf-8"), filename=str(WARDEN))
    constants = {"CARRIER_GUARD_CODES", "TERMINAL"}
    functions = {"require", "remaining", "key", "carrier_diagnostic_fact", "carrier_diagnostic_link",
                 "carrier_diagnostic_error", "capture_sudo_carrier_birth"}
    selected, found = [], set()
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in constants:
                ast.literal_eval(node.value)
                selected.append(node); found.add(node.targets[0].id)
        elif isinstance(node, ast.FunctionDef) and node.name in functions:
            if node.decorator_list:
                raise AssertionError("carrier diagnostic function gained a decorator")
            selected.append(node); found.add(node.name)
    if found != constants | functions:
        raise AssertionError("carrier diagnostic declarations changed")
    environment = {"re": re, "hashlib": hashlib, "stat": stat, "os": world.os,
                   "time": SimpleNamespace(monotonic=lambda: world.now),
                   "verified_metadata": world.metadata, "identity": world.identity,
                   "SCRIPT_SHA256": "c" * 64}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(WARDEN), "exec"), environment)
    capture = next(node for node in selected if isinstance(node, ast.FunctionDef) and node.name == "capture_sudo_carrier_birth")
    guards = [node for node in ast.walk(capture) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "require"]
    for guard in guards:
        if len(guard.args) != 2 or not isinstance(guard.args[1], ast.Constant) or guard.args[1].value not in environment["CARRIER_GUARD_CODES"]:
            raise AssertionError("every actual carrier guard needs its own fixed diagnostic code")
    return environment


class CarrierDiagnosticWorld:
    def __init__(self):
        self.now = 0
        self.carrier = {"pid": 10, "starttime": "100", "ppid": 9, "state": "S",
                        "uids": [1001, 0, 0, 0], "gids": [1001, 0, 0, 0], "secret": "NOT_FOR_RECEIPT"}
        self.launcher = {"pid": 9, "starttime": "80", "ppid": 1, "state": "S", "uids": [1001] * 4, "gids": [1001] * 4}
        self.guardian = {"pid": 11, "starttime": "110", "ppid": 10, "state": "R"}
        self.links = {"/proc/10/ns/pid": "pid:[42]", "/proc/9/ns/pid": "pid:[42]",
                      "/proc/self/ns/pid": "pid:[42]", "/proc/10/exe": "/usr/bin/sudo"}
        self.link_calls, self.closed, self.opened = [], [], []
        self.link_error = None
        self.data = b"sudo"
        self.offset = 0
        self.file = SimpleNamespace(st_mode=stat.S_IFREG | 0o4755, st_uid=0, st_gid=0,
                                    st_dev=1, st_ino=2, st_size=4, st_mtime_ns=3, st_ctime_ns=4)
        self.os = SimpleNamespace(getpid=lambda: 11, readlink=self.readlink, open=self.open,
                                  read=self.read, fstat=lambda _fd: self.file, stat=lambda _path: self.file,
                                  close=self.closed.append, O_RDONLY=0, O_CLOEXEC=1, O_NOFOLLOW=2)

    def identity(self, pid):
        return deepcopy({9: self.launcher, 10: self.carrier, 11: self.guardian}[pid])

    def metadata(self, pid):
        return self.identity(pid)

    def readlink(self, path):
        self.link_calls.append(path)
        if self.link_error is not None and path == "/proc/10/exe":
            raise self.link_error
        return self.links[path]

    def open(self, path, flags):
        if path != "/usr/bin/sudo" or flags != 3:
            raise AssertionError("diagnostic must not add a new path or open mode")
        self.opened.append(17)
        return 17

    def read(self, _fd, maximum):
        result = self.data[self.offset:self.offset + maximum]
        self.offset += len(result)
        return result


class CarrierDiagnosticContracts(unittest.TestCase):
    def call(self, world, creator=None):
        contract = carrier_diagnostic_contract(world)
        diagnostic = {"stage": "creator-identity", "completed": False, "facts": {}}
        descriptors = []
        try:
            result = contract["capture_sudo_carrier_birth"](creator or deepcopy(world.carrier),
                {"uid": 1001, "gid": 1001}, 50, descriptors, diagnostic)
            return result, diagnostic, descriptors
        except BaseException as error:
            diagnostic["error"] = contract["carrier_diagnostic_error"](error)
            self.last_diagnostic, self.last_descriptors = diagnostic, descriptors
            raise

    def test_real_AST_capture_preserves_reads_tuple_and_closes_fd(self):
        world = CarrierDiagnosticWorld()
        result, diagnostic, descriptors = self.call(world)
        self.assertEqual(result["carrierIdentity"]["uids"], [1001, 0, 0, 0])
        self.assertTrue(diagnostic["completed"]); self.assertEqual(diagnostic["stage"], "complete")
        self.assertEqual(diagnostic["facts"]["carrier"]["pid"], 10)
        self.assertEqual(diagnostic["facts"]["launcherNamespace"], {"value": "pid:[42]"})
        self.assertNotIn("NOT_FOR_RECEIPT", repr(diagnostic))
        self.assertEqual(world.link_calls, ["/proc/10/ns/pid", "/proc/9/ns/pid", "/proc/self/ns/pid",
                                            "/proc/10/exe", "/proc/10/exe", "/proc/10/ns/pid"])
        self.assertEqual(world.closed, [17]); self.assertEqual(descriptors, [])

    def test_guard_failure_records_specific_stage_and_code_without_default_tuple(self):
        for kind, stage, code in (("uid", "carrier-uid-role", "CARRIER_UID_ROLE_MISMATCH"),
                                  ("birth", "carrier-birth-identity", "CARRIER_BIRTH_CHANGED"),
                                  ("namespace", "host-namespace", "CARRIER_NAMESPACE_MISMATCH")):
            with self.subTest(kind=kind):
                world = CarrierDiagnosticWorld(); creator = deepcopy(world.carrier)
                if kind == "uid": world.carrier["uids"] = [0] * 4
                elif kind == "birth": world.carrier["starttime"] = "101"
                else: world.links["/proc/9/ns/pid"] = "pid:[43]"
                with self.assertRaises(RuntimeError): self.call(world, creator)
                self.assertEqual(self.last_diagnostic["stage"], stage)
                self.assertEqual(self.last_diagnostic["error"]["guardCode"], code)
                self.assertFalse(self.last_diagnostic["completed"]); self.assertEqual(world.opened, [])
                if kind == "uid": self.assertEqual(self.last_diagnostic["facts"]["carrier"]["uids"], [0] * 4)

    def test_carrier_GID_closed_enum_preserves_old_roles_and_accepts_observed_all_root_tuple(self):
        for gids, role in (([1001] * 4, "owner-group"), ([1001, 0, 0, 0], "root-group"),
                           ([0] * 4, "all-root-group")):
            with self.subTest(role=role):
                world = CarrierDiagnosticWorld(); world.carrier["gids"] = gids
                result, diagnostic, descriptors = self.call(world)
                self.assertEqual(result["gidRole"], role)
                self.assertEqual(result["carrierIdentity"]["gids"], gids)
                self.assertEqual(result["carrierIdentity"]["uids"], [1001, 0, 0, 0])
                self.assertTrue(diagnostic["completed"]); self.assertEqual(descriptors, [])
                self.assertEqual(world.closed, [17])
        for gids in ([0, 1001, 1001, 1001], [0, 0, 1001, 0], [1001, 0, 1001, 0], [7] * 4):
            with self.subTest(gids=gids):
                world = CarrierDiagnosticWorld(); world.carrier["gids"] = gids
                with self.assertRaisesRegex(RuntimeError, "sudo carrier GID role mismatch"): self.call(world)
                self.assertEqual(self.last_diagnostic["stage"], "carrier-gid-role")
                self.assertEqual(self.last_diagnostic["error"]["guardCode"], "CARRIER_GID_ROLE_MISMATCH")
                self.assertFalse(self.last_diagnostic["completed"]); self.assertEqual(world.opened, [])

    def test_all_root_GID_capture_rejects_changed_publication_readback(self):
        world = CarrierDiagnosticWorld(); world.carrier["gids"] = [0] * 4
        original = world.metadata; calls = 0
        def changed(pid):
            nonlocal calls
            value = original(pid)
            if pid == 10:
                calls += 1
                if calls == 2: value["gids"] = [1001, 0, 0, 0]
            return value
        world.metadata = changed
        with self.assertRaisesRegex(RuntimeError, "sudo carrier facts changed before publication"): self.call(world)
        self.assertEqual(self.last_diagnostic["stage"], "publication-recheck")
        self.assertFalse(self.last_diagnostic["completed"])
        self.assertEqual(world.closed, [17]); self.assertEqual(self.last_descriptors, [])

    def test_os_error_is_original_and_has_no_message_path_or_environment(self):
        world = CarrierDiagnosticWorld()
        original = PermissionError(errno.EACCES, "PRIVATE_ERROR", "/private/path")
        world.link_error = original
        with self.assertRaises(PermissionError) as failure: self.call(world)
        self.assertIs(failure.exception, original)
        self.assertEqual(self.last_diagnostic["stage"], "executable-link")
        self.assertEqual(self.last_diagnostic["error"], {"type": "PermissionError", "guardCode": "OS_OR_PARSE_FAILURE", "errno": errno.EACCES})
        self.assertNotIn("PRIVATE_ERROR", repr(self.last_diagnostic)); self.assertNotIn("/private/path", repr(self.last_diagnostic))
        self.assertEqual(world.opened, [])

    def test_executable_authority_failure_still_closes_registered_fd(self):
        world = CarrierDiagnosticWorld(); world.file.st_mode = stat.S_IFREG | 0o755
        with self.assertRaisesRegex(RuntimeError, "sudo carrier executable authority mismatch"): self.call(world)
        self.assertEqual(self.last_diagnostic["stage"], "executable-authority")
        self.assertEqual(self.last_diagnostic["error"]["guardCode"], "CARRIER_EXECUTABLE_AUTHORITY_MISMATCH")
        self.assertEqual(world.closed, [17]); self.assertEqual(self.last_descriptors, [])

    def test_unknown_path_and_message_are_hash_or_enum_only_deadline_unchanged(self):
        world = CarrierDiagnosticWorld(); world.links["/proc/10/exe"] = "/private/executable?secret"
        with self.assertRaises(RuntimeError): self.call(world)
        fact = self.last_diagnostic["facts"]["carrierExecutable"]
        self.assertIsNone(fact["value"]); self.assertEqual(fact["classification"], "unrecognized")
        self.assertEqual(fact["sha256"], hashlib.sha256(b"/private/executable?secret").hexdigest())
        self.assertNotIn("/private/executable", repr(self.last_diagnostic))
        contract = carrier_diagnostic_contract(world)
        self.assertEqual(contract["carrier_diagnostic_error"](RuntimeError("PRIVATE_ERROR"))["guardCode"], "UNCLASSIFIED_GUARD")
        world = CarrierDiagnosticWorld(); world.now = 51
        with self.assertRaisesRegex(RuntimeError, "aggregate warden deadline exhausted"): self.call(world)
        self.assertEqual(self.last_diagnostic["error"]["guardCode"], "DEADLINE_EXHAUSTED")
        self.assertEqual(world.opened, [])


def observer_metadata_contract(world):
    """The reviewed identity/metadata/marker functions, run against a controlled /proc (no CDLL, no privilege)."""
    tree = ast.parse(WARDEN.read_text(encoding="utf-8"), filename=str(WARDEN))
    names = {"require", "parse_stat", "identity", "key", "verified_metadata", "marker_facts"}
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in selected} != names:
        raise AssertionError("observer metadata declarations changed")
    def bounded_read(path, _maximum):
        return world.read(path)
    namespace = {"__builtins__": __builtins__, "re": re, "errno": errno, "bounded_read": bounded_read,
        "credentials": world.credentials, "STAT_LIMIT": 8192, "ENV_LIMIT": 1 << 20, "RUN_MARKER": b"APOLLO_PERCEPTION_RUN_ID="}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(WARDEN), "exec"), namespace)
    return namespace


def stat_text(pid, starttime="500", state="S", ppid=1):
    fields = ["0"] * 50
    fields[0], fields[1], fields[2], fields[3], fields[19] = state, str(ppid), str(pid), str(pid), starttime
    return ("%d (worker) %s" % (pid, " ".join(fields))).encode("ascii")


class MetadataWorld:
    """/proc/<pid>/stat answers come from a script per read, so a process can exit between two reads."""
    def __init__(self, stats, environ=b"APOLLO_PERCEPTION_RUN_ID=run-1\0"):
        self.stats, self.environ, self.reads = list(stats), environ, []

    def read(self, path):
        self.reads.append(path)
        if path.endswith("/stat"):
            answer = self.stats.pop(0) if len(self.stats) > 1 else self.stats[0]
            if isinstance(answer, OSError):
                raise answer
            return answer
        return self.environ

    def credentials(self, pid):
        return {"uids": [600] * 4, "gids": [700] * 4, "groups": []}


class ObserverMetadataRaces(unittest.TestCase):
    gone = FileNotFoundError(errno.ENOENT, "gone")

    def test_a_process_that_exits_between_the_two_stat_reads_is_a_disappearance_not_a_failure(self):
        world = MetadataWorld([stat_text(40), self.gone])
        contract = observer_metadata_contract(world)
        self.assertIsNone(contract["verified_metadata"](40))

    def test_an_identity_that_really_changed_still_fails_closed(self):
        world = MetadataWorld([stat_text(40, "500"), stat_text(40, "501")])
        contract = observer_metadata_contract(world)
        with self.assertRaisesRegex(RuntimeError, "identity changed during status read"):
            contract["verified_metadata"](40)

    def test_a_marker_read_of_a_process_that_exits_meanwhile_is_a_disappearance(self):
        # before: two stat reads, then the environment, then the recheck finds the process gone
        world = MetadataWorld([stat_text(40), stat_text(40), self.gone])
        contract = observer_metadata_contract(world)
        self.assertIsNone(contract["marker_facts"](40, {"pid": 40, "starttime": "500"}, "run-1"))

    def test_a_marker_read_whose_identity_changed_still_fails_closed(self):
        world = MetadataWorld([stat_text(40), stat_text(40), stat_text(40, "999"), stat_text(40, "999")])
        contract = observer_metadata_contract(world)
        with self.assertRaisesRegex(RuntimeError, "identity changed during status read|marker credentials changed"):
            contract["marker_facts"](40, {"pid": 40, "starttime": "500"}, "run-1")

    def test_a_marker_read_of_another_identity_than_requested_still_fails_closed(self):
        world = MetadataWorld([stat_text(40)])
        contract = observer_metadata_contract(world)
        with self.assertRaisesRegex(RuntimeError, "marker identity mismatch"):
            contract["marker_facts"](40, {"pid": 40, "starttime": "1"}, "run-1")

    def test_the_init_error_names_the_guard_that_raised_never_its_text(self):
        source = WARDEN.read_text(encoding="utf-8")
        self.assertIn('"guardCode": CARRIER_GUARD_CODES.get(str(error), "UNCLASSIFIED_GUARD")', source)
        for message in ("identity changed during status read", "marker credentials changed", "marker identity mismatch",
                        "inner Node failed", "owner died without authenticated finish"):
            self.assertIn('"%s": "' % message, source)


if __name__ == "__main__":
    unittest.main()
