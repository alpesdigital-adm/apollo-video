"""Pure configuration guards; no warden import/CDLL/process/network/privilege.

Execute the actual reviewed validate_config AST in isolation. Node executable
existence/access and time are controlled facts; UID/caps/kernel are not tested.
The JavaScript environment list is read as literal source, never executed.
"""
import ast
from copy import deepcopy
import os
from pathlib import Path
import re
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
        for kind in ("wait", "setsid-reparent", "zombie", "member-exit", "guardian-stop-owner-death"):
            validate({"mode": "fixture", "args": [kind]})
        validate({"mode": "namespace", "args": ["tests/v2/prisma-face-producer.integration.mjs", "publish-race|face control"]})
        for value in ({"mode": "exec", "args": ["sh"]}, {"mode": "unit", "args": ["arbitrary"]},
                      {"mode": "fixture", "args": ["arbitrary"]}, {"mode": "fixture", "args": ["wait", "extra"]},
                      {"mode": "namespace", "args": ["tests/v2/prisma-face-producer.integration.mjs"]},
                      {"mode": "unit", "args": [], "path": "arbitrary"}):
            with self.assertRaises(RuntimeError):
                validate(value)


if __name__ == "__main__":
    unittest.main()
