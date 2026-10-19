"""Disposable Linux CI authority. No product import, shell or general-purpose RPC.

The init observer exposes identity and attested marker facts, never environ bytes.
Executable entry points are completed separately from these reviewable primitives.
"""
import ctypes
import errno
import hashlib
import json
import os
import re
import select
import signal
import socket
import stat
import struct
import sys
import time

ABI = "apollo-perception-observer/v1"
FRAME_LIMIT = 65536
INVENTORY_LIMIT = 4096
ENV_LIMIT = 2 * 1024 * 1024
STATUS_LIMIT = 65536
STAT_LIMIT = 8192
RUN_MARKER = b"APOLLO_PERCEPTION_RUN_ID="
TERMINAL = ("Z", "X", "x")
CAP_KILL, CAP_DAC_READ_SEARCH, CAP_SYS_PTRACE = 5, 2, 19
INIT_CAPS = (CAP_KILL, CAP_DAC_READ_SEARCH, CAP_SYS_PTRACE)
LIBC = ctypes.CDLL(None, use_errno=True)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def remaining(deadline):
    value = deadline - time.monotonic()
    require(value > 0, "aggregate warden deadline exhausted")
    return value


def bounded_read(path, maximum):
    # Callers construct paths from validated numeric PIDs, never RPC paths.
    with open(path, "rb", buffering=0) as source:
        raw = source.read(maximum + 1)
    require(len(raw) <= maximum, "proc document exceeds observation bound")
    return raw


def parse_stat(raw):
    text = raw.decode("ascii", "strict")
    end = text.rfind(")")
    require(re.match(r"^[1-9][0-9]* \(", text) and end > text.index("(")
            and text[end:end + 2] == ") ", "malformed proc stat delimiter")
    pid = int(text.split(" ", 1)[0])
    fields = text[end + 2:].split()
    require(len(fields) >= 50 and re.fullmatch(r"[RSDZTtWXxIKP]", fields[0])
            and re.fullmatch(r"[0-9]+", fields[19])
            and all(re.fullmatch(r"-?[0-9]+", item) for item in fields[1:])
            and all(re.fullmatch(r"[0-9]+", item) for item in fields[1:4]),
            "incomplete proc identity")
    return {"pid": pid, "starttime": fields[19], "state": fields[0],
            "ppid": int(fields[1]), "processGroupId": int(fields[2]), "sessionId": int(fields[3])}


def identity(pid):
    require(type(pid) is int and pid > 0, "invalid proc PID")
    try:
        result = parse_stat(bounded_read("/proc/%d/stat" % pid, STAT_LIMIT))
        require(result["pid"] == pid, "proc PID mismatch")
        return result
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ESRCH):
            return None
        raise


def key(value):
    return (value["pid"], value["starttime"])


def credentials(pid):
    text = bounded_read("/proc/%d/status" % pid, STATUS_LIMIT).decode("ascii", "strict")
    fields = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
    result = {}
    for name in ("Uid", "Gid"):
        parts = fields.get(name, "").split()
        require(len(parts) == 4 and all(re.fullmatch(r"[0-9]+", value) for value in parts),
                "missing proc credentials")
        result[name.lower() + "s"] = [int(value) for value in parts]
    groups = fields.get("Groups", "").split()
    require("Groups" in fields and all(re.fullmatch(r"[0-9]+", value) for value in groups) and len(groups) <= 256,
            "invalid supplementary groups")
    result["groups"] = [int(value) for value in groups]
    for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
        value = fields.get(name, "").strip()
        require(re.fullmatch(r"[0-9a-fA-F]{16}", value), "missing proc capability measurement")
        result[name] = value.lower()
    require(fields.get("NoNewPrivs", "").strip() in ("0", "1"), "missing NoNewPrivs measurement")
    result["NoNewPrivs"] = int(fields["NoNewPrivs"].strip())
    # Root-owned proc inodes are diagnostic only: nondumpability can change them.
    result["inodeUid"] = os.stat("/proc/%d" % pid).st_uid
    environ_stat = os.stat("/proc/%d/environ" % pid)
    result["environInodeUid"] = environ_stat.st_uid
    result["environMode"] = oct(environ_stat.st_mode & 0o7777)
    result["uid"], result["gid"] = result["uids"][0], result["gids"][0]
    return result


def verified_metadata(pid):
    before = identity(pid)
    if before is None:
        return None
    owner = credentials(pid)
    after = identity(pid)
    require(after is not None and key(before) == key(after), "identity changed during status read")
    return {**after, **owner}


def marker_facts(pid, expected, run_id):
    before = verified_metadata(pid)
    if before is None:
        return None
    require(key(before) == key(expected), "marker identity mismatch")
    raw = bounded_read("/proc/%d/environ" % pid, ENV_LIMIT)
    run_marked = RUN_MARKER + run_id.encode("ascii") in raw.split(b"\0")
    known_marker = any(value.startswith(RUN_MARKER) and len(value) > len(RUN_MARKER)
                       for value in raw.split(b"\0"))
    del raw
    after = verified_metadata(pid)
    require(after is not None and key(before) == key(after) and before["uids"] == after["uids"]
            and before["gids"] == after["gids"], "marker credentials changed")
    return {"identity": after, "runMarked": run_marked, "knownMarker": known_marker,
            "attestation": "privileged-proc-environ-identity-recheck/v1"}


def prctl(option, argument=0):
    if LIBC.prctl(ctypes.c_int(option), ctypes.c_ulong(argument), 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl prerequisite failed")


def parent_death_signal():
    value = ctypes.c_int()
    if LIBC.prctl(ctypes.c_int(2), ctypes.byref(value), 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "parent-death readback failed")
    return value.value


def keep_capabilities():
    value = LIBC.prctl(ctypes.c_int(7), 0, 0, 0, 0)
    if value < 0:
        raise OSError(ctypes.get_errno(), "keepcaps readback failed")
    return value


def bind_parent_death(expected):
    prctl(1, signal.SIGKILL)
    require(parent_death_signal() == signal.SIGKILL and os.getppid() == expected["pid"],
            "parent-death signal or parent PID mismatch")
    current = identity(expected["pid"])
    require(current is not None and key(current) == key(expected) and current["state"] not in TERMINAL,
            "minted parent is no longer live")


def capset(capabilities):
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32),
                    ("inheritable", ctypes.c_uint32)]
    mask = sum(1 << value for value in capabilities)
    values = (Data * 2)()
    for index in range(2):
        values[index].effective = values[index].permitted = (mask >> (32 * index)) & 0xffffffff
    if LIBC.capset(ctypes.byref(Header(0x20080522, 0)), ctypes.byref(values)) != 0:
        raise OSError(ctypes.get_errno(), "capset prerequisite failed")


def reduce_capabilities(retained):
    # Drop bounding while CAP_SETPCAP is still present, then lose SETPCAP itself.
    last = int(bounded_read("/proc/sys/kernel/cap_last_cap", 32).strip())
    require(0 <= last <= 63, "unsupported capability range")
    prctl(47, 4)  # PR_CAP_AMBIENT / PR_CAP_AMBIENT_CLEAR_ALL
    for capability in range(last + 1):
        if capability not in retained:
            prctl(24, capability)  # PR_CAPBSET_DROP
    capset(retained)
    prctl(38, 1)  # PR_SET_NO_NEW_PRIVS


def assert_capabilities(value, retained):
    expected = sum(1 << item for item in retained)
    require(all(int(value[name], 16) == expected for name in ("CapEff", "CapPrm", "CapBnd"))
            and int(value["CapInh"], 16) == 0 and int(value["CapAmb"], 16) == 0
            and value["NoNewPrivs"] == 1, "capability attestation failed")


def pidfd_signal(expected, requested, deadline):
    require(requested in (signal.SIGTERM, signal.SIGKILL), "unsupported containment signal")
    remaining(deadline)
    require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "pidfd APIs required")
    descriptor = None
    try:
        descriptor = os.pidfd_open(expected["pid"], 0)
        current = identity(expected["pid"])
        if current is None:
            return {"result": "absent"}
        if key(current) != key(expected):
            return {"result": "pid-recycled"}
        if current["state"] in TERMINAL:
            return {"result": "terminal-state", "state": current["state"]}
        remaining(deadline)
        signal.pidfd_send_signal(descriptor, requested, None, 0)
        return {"result": "signaled"}
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ESRCH):
            raise
        current = identity(expected["pid"])
        require(current is None or key(current) != key(expected) or current["state"] in TERMINAL,
                "pidfd lookup race did not prove terminality")
        return {"result": "lookup-confirmed-terminal"}
    finally:
        if descriptor is not None:
            os.close(descriptor)


def init_namespace_pids(expected):
    status = bounded_read("/proc/%d/status" % expected["pid"], STATUS_LIMIT).decode("ascii", "strict")
    fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    values = fields.get("NSpid", "").split()
    require(2 <= len(values) <= 32 and all(value.isdigit() for value in values)
            and int(values[0]) == expected["pid"] and int(values[-1]) == 1,
            "minted init namespace PID binding mismatch")
    return [int(value) for value in values]


def mint_init_stop_anchor(expected, birth, unshare, descriptors, deadline):
    # Register BEFORE revalidation, so host_main's existing finally owns even
    # a failed binding. No fd is exposed in the launcher receipt or to product.
    remaining(deadline)
    require(type(expected["pid"]) is int and expected["pid"] > 1 and unshare["pid"] > 1
            and key(expected) == key(birth["hostIdentity"]), "invalid minted init host identity")
    init_fd = os.pidfd_open(expected["pid"], 0)
    descriptors.append(init_fd)
    current, parent = identity(expected["pid"]), identity(unshare["pid"])
    require(current is not None and key(current) == key(expected) and current["state"] not in TERMINAL
            and current["ppid"] == unshare["pid"] and parent is not None and key(parent) == key(unshare)
            and parent["ppid"] == os.getpid() and parent["state"] not in TERMINAL,
            "minted init parent or identity changed after pidfd open")
    namespace_path = "/proc/%d/ns/pid" % expected["pid"]
    namespace_fd = os.open(namespace_path, os.O_RDONLY | os.O_CLOEXEC)
    descriptors.append(namespace_fd)
    namespace = os.readlink(namespace_path)
    require(namespace == birth["namespace"]["pid"] and namespace != os.readlink("/proc/self/ns/pid"),
            "init PID namespace not isolated")
    require(os.readlink("/proc/%d/ns/mnt" % expected["pid"]) == birth["namespace"]["mount"]
            and birth["namespace"]["mount"] != os.readlink("/proc/self/ns/mnt"), "init mount namespace not isolated")
    namespace_stat, pidfd_stat = os.fstat(namespace_fd), os.fstat(init_fd)
    match = re.fullmatch(r"pid:\[([1-9][0-9]*)\]", namespace)
    require(match is not None and namespace_stat.st_ino == int(match.group(1)), "init namespace token inode mismatch")
    pids = init_namespace_pids(expected)
    after = identity(expected["pid"])
    require(after is not None and key(after) == key(expected) and after["ppid"] == unshare["pid"]
            and after["state"] not in TERMINAL, "init identity changed during namespace binding")
    remaining(deadline)
    return {"identity": dict(expected), "birthIdentity": dict(birth["hostIdentity"]), "unshare": dict(unshare),
            "pidfd": init_fd, "pidfdStat": (pidfd_stat.st_dev, pidfd_stat.st_ino),
            "namespaceFd": namespace_fd, "namespaceStat": (namespace_stat.st_dev, namespace_stat.st_ino),
            "namespace": namespace, "namespacePids": pids,
            "namespaceBinding": "birth-bound-retained-pid-namespace-token/v1"}


def revalidate_init_stop_anchor(anchor, deadline):
    remaining(deadline)
    expected, unshare = anchor["identity"], anchor["unshare"]
    require(type(expected["pid"]) is int and expected["pid"] > 1 and unshare["pid"] > 1
            and key(expected) == key(anchor["birthIdentity"]), "invalid retained init host identity")
    pidfd_stat, namespace_stat = os.fstat(anchor["pidfd"]), os.fstat(anchor["namespaceFd"])
    require((pidfd_stat.st_dev, pidfd_stat.st_ino) == anchor["pidfdStat"]
            and (namespace_stat.st_dev, namespace_stat.st_ino) == anchor["namespaceStat"],
            "retained init token changed")
    current, parent = identity(expected["pid"]), identity(unshare["pid"])
    require(current is not None and key(current) == key(expected) and current["state"] not in TERMINAL
            and current["ppid"] == unshare["pid"] and parent is not None and key(parent) == key(unshare)
            and parent["ppid"] == os.getpid() and parent["state"] not in TERMINAL,
            "retained init identity or parent changed")
    # PID namespace membership of an existing process is immutable; the token
    # was bound while privileged. No root-namespace readlink after UID/cap drop.
    require(init_namespace_pids(expected) == anchor["namespacePids"], "retained init namespace PID binding changed")
    after = identity(expected["pid"])
    require(after is not None and key(after) == key(expected) and after["ppid"] == unshare["pid"]
            and after["state"] not in TERMINAL, "init identity changed during stop revalidation")
    remaining(deadline)
    return after


def stop_minted_init(anchor, deadline, evidence):
    # Fixed controlled fault only, from the ancestor guardian (pid_namespaces(7)).
    # Do not add SIGSTOP to the generic TERM/KILL containment helper or RPC.
    stop_deadline = min(deadline, time.monotonic() + 1)
    evidence.update(stopDeadlineMonotonic=stop_deadline, failureStage="target-revalidation")
    try:
        revalidate_init_stop_anchor(anchor, stop_deadline)
        remaining(stop_deadline)
        evidence.update(failureStage="signal", stopAttempted=True)
        signal.pidfd_send_signal(anchor["pidfd"], signal.SIGSTOP, None, 0)
        evidence.update(stopAccepted=True, failureStage="stopped-readback")
        while True:
            stopped = revalidate_init_stop_anchor(anchor, stop_deadline)
            if stopped["state"] in ("T", "t"):
                remaining(stop_deadline)
                evidence.update(stopObserved=True, observedIdentity=stopped, failureStage=None)
                return
            time.sleep(min(0.01, remaining(stop_deadline)))
    except BaseException as error:
        message = str(error).encode("utf8", "replace")
        evidence["error"] = {"type": type(error).__name__, "errno": getattr(error, "errno", None),
                             "messageSha256": hashlib.sha256(message).hexdigest(), "messageBytes": len(message)}
        raise


def guardian_product_gate(config, report, anchor, release_write, execution_deadline, deadline):
    if config["controlledFault"] == "init-stop":
        report["faultEvidence"] = {"kind": "init-stop", "launcherAckObserved": False,
            "stopAttempted": False, "stopAccepted": False, "stopObserved": False, "nodeGateReleased": False,
            "namespaceBinding": anchor["namespaceBinding"], "pidNamespace": anchor["namespace"],
            "namespaceToken": {"device": anchor["namespaceStat"][0], "inode": anchor["namespaceStat"][1]},
            "namespacePids": anchor["namespacePids"][:]}
    gate_deadline = min(execution_deadline, time.monotonic() + 5)
    require(select.select([0], [], [], remaining(gate_deadline))[0], "external pidfd attestation gate timeout")
    require(os.read(0, 64) == b"G", "outer launcher denied Node exec gate")
    if config["controlledFault"] == "init-stop":
        report["faultEvidence"]["launcherAckObserved"] = True
        stop_minted_init(anchor, execution_deadline, report["faultEvidence"])
        raise RuntimeError("controlled init stop requires namespace containment")
    packet_write(release_write, {"abi": ABI, "runId": config["runId"], "release": "product"}, deadline)


class OwnerChannel:
    """One minted owner; credentials checked on EVERY recvmsg fragment."""
    def __init__(self, channel, owner, uid, gid, run_id, deadline):
        self.channel, self.owner, self.uid, self.gid = channel, owner, uid, gid
        self.run_id, self.deadline, self.sequence = run_id, deadline, 0
        self.buffer = bytearray()
        self.failure_fact = None
        channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        channel.setblocking(False)

    def receive(self):
        while len(self.buffer) < 4 or len(self.buffer) < 4 + struct.unpack("!I", self.buffer[:4])[0]:
            if len(self.buffer) >= 4:
                if not 0 < struct.unpack("!I", self.buffer[:4])[0] <= FRAME_LIMIT:
                    self.failure_fact = {"code": "IPC_FRAME_SIZE", "declaredBytes": struct.unpack("!I", self.buffer[:4])[0]}
                require(0 < struct.unpack("!I", self.buffer[:4])[0] <= FRAME_LIMIT, "invalid IPC frame size")
            require(select.select([self.channel], [], [], min(2, remaining(self.deadline)))[0], "IPC receive timeout")
            raw, ancillary, flags, _ = self.channel.recvmsg(FRAME_LIMIT + 4, socket.CMSG_SPACE(12))
            passed_fds = False
            for level, kind, data in ancillary:
                if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                    passed_fds = True
                    for offset in range(0, len(data) - len(data) % 4, 4):
                        os.close(struct.unpack("i", data[offset:offset + 4])[0])
            if not raw:
                self.failure_fact = {"code": "IPC_TRUNCATED" if self.buffer else "IPC_EOF", "bufferedBytes": len(self.buffer)}
            require(raw and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), "IPC EOF or truncated credentials")
            require(not passed_fds and len(ancillary) == 1 and ancillary[0][:2] == (socket.SOL_SOCKET, socket.SCM_CREDENTIALS)
                    and len(ancillary[0][2]) == 12, "IPC requires exactly kernel credentials, no passed FDs")
            sender = struct.unpack("3i", ancillary[0][2])
            require(sender == (self.owner["pid"], self.uid, self.gid), "IPC fragment is not from minted owner")
            current = verified_metadata(self.owner["pid"])
            require(current is not None and key(current) == key(self.owner)
                    and current["uids"] == [self.uid] * 4 and current["gids"] == [self.gid] * 4,
                    "IPC owner identity or credentials changed")
            self.buffer.extend(raw)
            require(len(self.buffer) <= FRAME_LIMIT + 4, "IPC buffer exceeds bound")
        size = struct.unpack("!I", self.buffer[:4])[0]
        require(0 < size <= FRAME_LIMIT and len(self.buffer) == size + 4, "IPC pipelining or invalid frame")
        request = strict_json(bytes(self.buffer[4:]))
        self.buffer.clear()
        require(type(request) is dict and request.get("abi") == ABI and request.get("runId") == self.run_id
                and type(request.get("seq")) is int and request["seq"] == self.sequence + 1,
                "IPC ABI, owner run ID or sequence mismatch")
        self.sequence = request["seq"]
        require(self.sequence <= 100000, "IPC sequence bound exceeded")
        return request

    def send(self, response):
        document = {"abi": ABI, "runId": self.run_id, "seq": self.sequence, **response}
        raw = json.dumps(document, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        require(0 < len(raw) <= FRAME_LIMIT, "IPC response exceeds frame bound")
        pending = memoryview(struct.pack("!I", len(raw)) + raw)
        while pending:
            require(select.select([], [self.channel], [], min(2, remaining(self.deadline)))[1], "IPC send timeout")
            written = self.channel.send(pending)
            require(written > 0, "IPC send closed")
            pending = pending[written:]


SUITES = frozenset((
    "tesseract-ocr-video-adapter", "ffmpeg-temporal-video-analyzer",
    "prisma-perception-producer-admission", "prisma-perception-producer-worker",
    "prisma-perception-producer-http", "prisma-director-ocr", "prisma-temporal-producer",
    "prisma-server-perception-snapshot", "prisma-director-server-perception", "server-perception-snapshot-server",
    "prisma-face-producer", "perception-namespace-observer",
))
CONTROLLED_FAULTS = frozenset(("guardian-stop", "init-stop", "node-owner-death", "ipc-death", "ipc-truncated", "ipc-oversized", "deadline"))
BASE = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPT = os.path.realpath(__file__)
SCRIPT_SHA256 = hashlib.sha256(bounded_read(SCRIPT, 256 * 1024)).hexdigest()
ENV_NAMES = frozenset((
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "CI", "RUNNER_TEMP",
    "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "NEXT_TELEMETRY_DISABLED",
    "APOLLO_API_ENVIRONMENT", "V2_DATABASE_URL", "APOLLO_LIBRARY_EVIDENCE_ROOT",
    "APOLLO_V2_ARTIFACT_STORAGE_DRIVER", "APOLLO_V2_ARTIFACT_ROOT",
    "APOLLO_PROTECTED_PAYLOAD_KEY_ID", "APOLLO_PROTECTED_PAYLOAD_KEY",
    "APOLLO_OCR_VIDEO_E2E", "APOLLO_PERCEPTION_HTTP_E2E", "APOLLO_TEMPORAL_VIDEO_E2E",
    "APOLLO_TEMPORAL_HTTP_E2E", "APOLLO_OCR_TESSERACT", "APOLLO_OCR_TESSDATA",
    "APOLLO_OCR_FFMPEG", "APOLLO_TEMPORAL_FFMPEG", "APOLLO_OCR_FFPROBE",
    "APOLLO_TEMPORAL_FFPROBE", "FFMPEG_BIN", "FFPROBE_BIN",
    "APOLLO_PERCEPTION_PIDFD_ADDON", "APOLLO_PERCEPTION_PIDFD_PROVENANCE", "APOLLO_PERCEPTION_PIDFD_SHA256",
    "APOLLO_PERCEPTION_PIDFD_ROOT", "APOLLO_PERCEPTION_CONSUMER_RUN_ID",
    "APOLLO_PERCEPTION_CGROUP_SCOPE",
))


def validate_config(document):
    require(type(document) is dict and set(document) == {
        "abi", "runId", "uid", "gid", "node", "suite", "pattern", "environment",
        "deadlineAt", "innerDeadlineAt", "sourceCommit", "controlledFault"}, "invalid launcher configuration")
    require(document["abi"] == ABI and re.fullmatch(r"perception-namespace-[a-z0-9-]{1,100}", document["runId"]),
            "invalid launcher ABI or run ID")
    require(type(document["uid"]) is int and document["uid"] > 0
            and type(document["gid"]) is int and document["gid"] > 0, "product must use a normal UID/GID")
    require(os.path.isabs(document["node"]) and os.path.basename(document["node"]) == "node"
            and os.path.isfile(document["node"]) and os.access(document["node"], os.X_OK), "invalid Node executable")
    match = re.fullmatch(r"tests/v2/([a-z0-9-]+)\.integration\.mjs", document["suite"])
    require(match and match[1] in SUITES, "suite is outside the fixed CI launch contract")
    require(document["controlledFault"] is None or (match[1] == "perception-namespace-observer"
            and document["controlledFault"] in CONTROLLED_FAULTS), "fault is outside the fixed composed gate")
    require(document["pattern"] is None or (match[1] == "prisma-face-producer"
            and document["pattern"] == "publish-race|face control"), "unexpected suite filter")
    require(re.fullmatch(r"[0-9a-f]{40}", document["sourceCommit"]), "source commit is required")
    require(type(document["environment"]) is dict and set(document["environment"]) <= ENV_NAMES
            and all(type(value) is str and "\0" not in value and len(value) <= 8192
                    for value in document["environment"].values()), "environment is outside the launch allowlist")
    require(document["environment"].get("GITHUB_SHA") == document["sourceCommit"], "source commit mismatch")
    now = time.time() * 1000
    require(type(document["deadlineAt"]) is int and type(document["innerDeadlineAt"]) is int
            and now + 390000 <= document["innerDeadlineAt"]
            and document["innerDeadlineAt"] + 30000 <= document["deadlineAt"]
            and document["deadlineAt"] <= now + 480000, "insufficient or unbounded launcher deadline")
    return document


def strict_json(raw):
    def pairs(items):
        result = {}
        for name, value in items:
            require(name not in result, "duplicate JSON field")
            result[name] = value
        return result
    return json.loads(raw.decode("utf8", "strict"), object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False, "non-finite JSON value"))


def read_config(descriptor):
    raw = bytearray()
    deadline = time.monotonic() + 5
    while b"\n" not in raw:
        require(select.select([descriptor], [], [], remaining(deadline))[0], "launcher configuration timeout")
        remaining(deadline)  # Read readiness cannot extend the total budget.
        value = os.read(descriptor, 16384)
        require(value, "launcher closed before configuration")
        raw.extend(value)
        require(len(raw) <= 131072, "launcher configuration exceeds bound")
    line, extra = bytes(raw).split(b"\n", 1)
    require(not extra, "configuration pipelining prohibited")
    return validate_config(strict_json(line))


def packet_write(descriptor, document, deadline):
    raw = json.dumps(document, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    require(len(raw) <= FRAME_LIMIT, "root receipt exceeds frame bound")
    view = memoryview(struct.pack("!I", len(raw)) + raw)
    while view:
        require(select.select([], [descriptor], [], min(2, remaining(deadline)))[1], "root receipt write timeout")
        count = os.write(descriptor, view)
        require(count > 0, "root receipt channel closed")
        view = view[count:]


def buffered_packet(buffer):
    require(len(buffer) <= 2 * (FRAME_LIMIT + 4), "root receipt buffer exceeds bound")
    if len(buffer) < 4:
        return None
    size = struct.unpack("!I", buffer[:4])[0]
    require(0 < size <= FRAME_LIMIT, "invalid root receipt frame")
    if len(buffer) < size + 4:
        return None
    result = strict_json(bytes(buffer[4:size + 4]))
    del buffer[:size + 4]
    return result


def packet_read(descriptor, buffer):
    pending = buffered_packet(buffer)
    if pending is not None:
        return pending
    value = os.read(descriptor, FRAME_LIMIT + 4)
    require(value, "root receipt channel truncated" if buffer else "root receipt channel closed")
    buffer.extend(value)
    return buffered_packet(buffer)


def reaps():
    results = []
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == 0:
            break
        results.append({"pid": pid, "waitStatus": status, "exitCode": os.waitstatus_to_exitcode(status)})
    return results


def namespace_inventory(deadline):
    remaining(deadline)
    pids = [int(value) for value in os.listdir("/proc") if value.isdigit()]
    require(len(pids) <= INVENTORY_LIMIT, "namespace inventory exceeds bound")
    result, errors = [], []
    for pid in pids:
        remaining(deadline)
        try:
            value = verified_metadata(pid)
            if value is not None:
                result.append({"pid": pid, "identity": value, "error": None})
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ESRCH):
                errors.append({"pid": pid, "identity": None, "error": errno.errorcode.get(error.errno, "EUNKNOWN")})
        except Exception:
            errors.append({"pid": pid, "identity": None, "error": "EMETADATA"})
    # Independently verified items remain available even when another PID fails.
    return result + errors


def namespace_cleanup(owner, known, deadline):
    report = {"signals": [], "errors": [], "reaped": [], "namespaceEmpty": False}
    for requested in (signal.SIGTERM, signal.SIGKILL):
        try:
            for item in namespace_inventory(deadline):
                if item["error"]:
                    report["errors"].append(item)
                elif item["pid"] != 1:
                    known[key(item["identity"])] = item["identity"]
            require(len(known) <= INVENTORY_LIMIT, "containment inventory exceeds bound")
            for value in reversed(list(known.values())):
                remaining(deadline)
                if value["pid"] != 1:
                    report["signals"].append({"pid": value["pid"], "starttime": value["starttime"],
                        "signal": requested, **pidfd_signal(value, requested, deadline)})
            if requested == signal.SIGTERM:
                time.sleep(min(0.25, remaining(deadline)))
            while remaining(deadline) > 0:
                report["reaped"].extend(reaps())
                items = namespace_inventory(deadline)
                if not any(item["pid"] != 1 for item in items):
                    report["namespaceEmpty"] = True
                    report["finalInventory"] = items
                    return report
                if requested == signal.SIGTERM:
                    break
                for item in items:
                    if item["error"]:
                        report["errors"].append(item)
                    elif item["pid"] != 1:
                        value = item["identity"]
                        known[key(value)] = value
                        report["signals"].append({"pid": value["pid"], "starttime": value["starttime"],
                            "signal": requested, **pidfd_signal(value, requested, deadline)})
                time.sleep(min(0.05, remaining(deadline)))
        except Exception as error:
            report["errors"].append(type(error).__name__)
    return report


def mount_private_proc():
    require(os.getpid() == 1 and os.getuid() == 0, "warden init requires a root PID namespace")
    # unshare already made propagation private. Repeat explicitly before mount.
    if LIBC.mount(None, b"/", None, ctypes.c_ulong((1 << 14) | (1 << 18)), None) != 0:
        raise OSError(ctypes.get_errno(), "private propagation prerequisite failed")
    if LIBC.mount(b"proc", b"/proc", b"proc", ctypes.c_ulong(2 | 4 | 8), None) != 0:
        raise OSError(ctypes.get_errno(), "private proc mount prerequisite failed")
    require(identity(1)["pid"] == 1 and os.readlink("/proc/self/ns/pid") == os.readlink("/proc/1/ns/pid"),
            "proc is not bound to the new PID namespace")
    text = bounded_read("/proc/self/mountinfo", 1024 * 1024).decode("utf8", "strict")
    mounts = [line.split() for line in text.splitlines()]
    require(any(parts[4] == "/proc" and "proc" in parts[parts.index("-") + 1:] for parts in mounts), "private proc missing")
    require(not any(any(value.startswith(("shared:", "master:", "propagate_from:"))
                        for value in parts[6:parts.index("-")]) for parts in mounts),
            "mount propagation is not private")


def drop_product(uid, gid):
    # No product code runs in this Python bootstrap. Drop bounding with SETPCAP
    # before the UID transition automatically removes permitted/effective caps.
    last = int(bounded_read("/proc/sys/kernel/cap_last_cap", 32).strip())
    require(0 <= last <= 63, "unsupported capability range")
    prctl(47, 4)
    for capability in range(last + 1):
        prctl(24, capability)
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    capset(())
    prctl(38, 1)
    value = verified_metadata(os.getpid())
    require(value["uids"] == [uid] * 4 and value["gids"] == [gid] * 4 and os.getgroups() == [],
            "bootstrap credential drop failed")
    assert_capabilities(value, ())
    require(keep_capabilities() == 0, "product bootstrap must never keep capabilities")


def drop_guardian(uid, gid, parent):
    # The reviewed guardian is the ONLY temporary keepcaps transition. It
    # never execs again; its final flag is zero. Product bootstrap never sets it.
    last = int(bounded_read("/proc/sys/kernel/cap_last_cap", 32).strip())
    require(0 <= last <= 63, "unsupported capability range")
    prctl(47, 4)
    for capability in range(last + 1):
        if capability != CAP_KILL:
            prctl(24, capability)
    os.setgroups([])
    prctl(8, 1)
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    capset((CAP_KILL,))
    prctl(8, 0)
    prctl(38, 1)
    # Credential/capability transitions can clear PDEATHSIG: reinstall LAST.
    bind_parent_death(parent)
    value = verified_metadata(os.getpid())
    require(value["uids"] == [uid] * 4 and value["gids"] == [gid] * 4 and value["groups"] == [],
            "guardian credential drop failed")
    assert_capabilities(value, (CAP_KILL,))
    require(keep_capabilities() == 0, "guardian keepcaps must be disabled after transition")
    return value


class Observer:
    def __init__(self, config, owner, channel, authority, deadline):
        self.config, self.owner, self.authority, self.deadline = config, owner, authority, deadline
        self.channel = OwnerChannel(channel, owner, config["uid"], config["gid"], config["runId"], deadline)
        self.snapshot, self.page, self.generation = [], 0, 0
        self.finished = False
        self.hello = False

    def dispatch(self, request):
        common = {"abi", "runId", "seq", "op"}
        op = request.get("op")
        require(op in ("hello", "snapshot", "identity", "markers", "finish"), "unsupported observer operation")
        require(set(request) == common | ({"token"} if op == "snapshot" else
            {"pid", "starttime"} if op == "markers" else {"pid"} if op == "identity" else set()),
            "unexpected observer fields")
        require(not self.finished, "observer already finished")
        require(self.hello or op == "hello", "hello must be the first authenticated request")
        if op == "hello":
            require(not self.hello, "observer hello is single-use")
            value = verified_metadata(self.owner["pid"])
            require(value is not None and key(value) == key(self.owner), "owner missing before hello")
            assert_capabilities(value, ())
            self.hello = True
            return {"abi": ABI, "owner": value, "authority": self.authority}
        if op == "identity":
            return verified_metadata(request["pid"])
        if op == "markers":
            require(type(request["starttime"]) is str and re.fullmatch(r"[0-9]+", request["starttime"]), "invalid marker identity")
            value = verified_metadata(request["pid"])
            if value is None:
                return None
            require(value["uids"] == [self.config["uid"]] * 4, "marker read outside product credentials")
            return marker_facts(request["pid"], request, self.config["runId"])
        if op == "snapshot":
            if request["token"] is None:
                self.snapshot = namespace_inventory(self.deadline)
                self.page = 0
                self.generation += 1
            else:
                require(request["token"] == "%d:%d" % (self.generation, self.page), "invalid snapshot cursor")
            result = self.snapshot[self.page:self.page + 32]
            self.page += len(result)
            token = None if self.page == len(self.snapshot) else "%d:%d" % (self.generation, self.page)
            return {"entries": result, "nextToken": token}
        self.finished = True
        return {"finished": True}

    def service(self):
        request = self.channel.receive()
        try:
            result = self.dispatch(request)
        except OSError as error:
            self.channel.send({"ok": False, "error": {"code": errno.errorcode.get(error.errno, "EUNKNOWN")}})
        else:
            self.channel.send({"ok": True, "result": result})


def deadline_from_epoch(epoch):
    require(type(epoch) is int and epoch > time.time() * 1000, "expired absolute run deadline")
    return time.monotonic() + epoch / 1000 - time.time()


def read_packet_wait(descriptor, deadline, buffer=None):
    if buffer is None:
        buffer = bytearray()
    while True:
        pending = buffered_packet(buffer)
        if pending is not None:
            return pending
        require(select.select([descriptor], [], [], min(2, remaining(deadline)))[0], "bootstrap gate timeout")
        value = packet_read(descriptor, buffer)
        if value is not None:
            return value


def alarm_handler(_signal, _frame):
    raise TimeoutError("warden absolute deadline")


def init_main(expected_unshare):
    config = read_config(0)
    deadline = deadline_from_epoch(config["deadlineAt"])
    signal.signal(signal.SIGALRM, alarm_handler)
    execution_deadline = deadline - 25
    signal.setitimer(signal.ITIMER_REAL, remaining(execution_deadline))
    report = {"abi": ABI, "runId": config["runId"], "stage": "init", "sourceCommit": config["sourceCommit"],
              "success": False, "order": [], "errors": [], "reaped": [], "nodeCloseObserved": False,
              "wardenSha256": SCRIPT_SHA256}
    owner, observer, known = None, None, {}
    namespace_established = False
    channels = []
    interrupted = []
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda signum, _frame: interrupted.append(signum))
    try:
        # The only host proc accesses in init are its own identity and creator.
        host_self = parse_stat(bounded_read("/proc/self/stat", STAT_LIMIT))
        creator = verified_metadata(expected_unshare["pid"])
        require(creator is not None and key(creator) == key(expected_unshare)
                and host_self["ppid"] == creator["pid"], "init is not the minted unshare child")
        require(parent_death_signal() == signal.SIGKILL, "unshare did not preserve kill-child parent-death signal")
        host_namespace = os.readlink("/proc/self/ns/pid")
        report["hostIdentity"], report["creator"] = host_self, expected_unshare
        packet_write(3, {**report, "stage": "init-minted", "namespace": {
            "pid": host_namespace, "mount": os.readlink("/proc/self/ns/mnt")}}, deadline)
        mount_private_proc()
        namespace_established = True
        report["order"].append("private-propagation-and-proc-mounted")
        report["namespace"] = {"pid": os.readlink("/proc/self/ns/pid"), "mount": os.readlink("/proc/self/ns/mnt"),
                               "initIdentity": identity(1), "preMountPidNamespace": host_namespace}
        rpc_parent, rpc_child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        rpc_parent.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        gate_read, gate_write = os.pipe()
        ready_read, ready_write = os.pipe()
        channels = [rpc_parent, rpc_child]
        child_pid = os.fork()
        if child_pid == 0:
            try:
                rpc_parent.close()
                os.close(gate_write); os.close(ready_read)
                # Root receipt and guardian-release descriptors never reach Node.
                os.close(3); os.close(4)
                drop_product(config["uid"], config["gid"])
                os.write(ready_write, b"R")
                require(select.select([gate_read], [], [], min(5, remaining(deadline)))[0], "trusted Node bootstrap exec gate timeout")
                require(os.read(gate_read, 1) == b"X", "trusted Node bootstrap exec gate denied")
                rpc_fd = rpc_child.fileno()
                import fcntl
                sources = [fcntl.fcntl(value, fcntl.F_DUPFD_CLOEXEC, 10)
                           for value in (rpc_fd, gate_read, ready_write)]
                for source, destination in zip(sources, (3, 4, 5)):
                    os.dup2(source, destination, inheritable=True)
                null = os.open("/dev/null", os.O_RDONLY)
                os.dup2(null, 0); os.close(null)
                for descriptor in range(3, min(4096, os.sysconf("SC_OPEN_MAX"))):
                    if descriptor not in (3, 4, 5):
                        try:
                            os.close(descriptor)
                        except OSError:
                            pass
                environment = dict(config["environment"])
                environment.update({"APOLLO_OBSERVER_FD": "3", "APOLLO_OBSERVER_RUN_ID": config["runId"],
                    "APOLLO_NAMESPACE_GATE_FD": "4", "APOLLO_NAMESPACE_READY_FD": "5",
                    "APOLLO_NAMESPACE_UID": str(config["uid"]), "APOLLO_NAMESPACE_GID": str(config["gid"]),
                    "APOLLO_PERCEPTION_NAMESPACE_REQUIRED": "1",
                    "APOLLO_PERCEPTION_JOB_DEADLINE_MS": str(config["innerDeadlineAt"])})
                if config["controlledFault"] is not None:
                    environment["APOLLO_PERCEPTION_NAMESPACE_FAULT"] = config["controlledFault"]
                args = [config["node"], os.path.join(BASE, "scripts/validation/perception-namespace-node-bootstrap.mjs"), config["suite"]]
                if config["pattern"] is not None:
                    args.append(config["pattern"])
                os.chdir(BASE)
                os.execve(config["node"], args, environment)
            except BaseException:
                os._exit(126)
        rpc_child.close()
        os.close(gate_read); os.close(ready_write)
        owner = verified_metadata(child_pid)
        require(owner is not None, "forked owner identity unavailable")
        owner_fd = os.pidfd_open(child_pid, 0)
        known[key(owner)] = owner
        require(select.select([ready_read], [], [], min(5, remaining(deadline)))[0], "bootstrap readiness timeout")
        require(os.read(ready_read, 1) == b"R", "bootstrap readiness failed")
        owner_after = verified_metadata(child_pid)
        require(owner_after is not None and key(owner_after) == key(owner)
                and owner_after["uids"] == [config["uid"]] * 4 and owner_after["gids"] == [config["gid"]] * 4
                and owner_after["groups"] == [],
                "minted bootstrap identity or credential mismatch")
        assert_capabilities(owner_after, ())
        owner = owner_after
        report["order"].append("normal-bootstrap-dropped-and-measured")
        report["owner"] = owner
        reduce_capabilities(INIT_CAPS)
        # Init never changes UID/GID, only reduces capabilities. No host proc
        # FD survives mount. Reject kernels/versions that lost PDEATHSIG; never
        # reinstall it after a lost binding to an invisible ancestor.
        require(parent_death_signal() == signal.SIGKILL, "init lost the verified unshare parent-death binding")
        authority = verified_metadata(1)
        assert_capabilities(authority, INIT_CAPS)
        report["authority"] = authority
        report["parentDeathSignal"] = parent_death_signal()
        report["order"].append("init-minimal-capabilities-measured")
        packet_write(3, {**report, "stage": "init-ready"}, deadline)
        host_attestation = read_packet_wait(4, deadline)
        require(host_attestation.get("abi") == ABI and host_attestation.get("runId") == config["runId"]
                and host_attestation.get("release") == "bootstrap-only", "guardian did not release trusted Node bootstrap")
        assert_capabilities(host_attestation["guardian"], (CAP_KILL,))
        require(host_attestation["guardian"]["uids"] == [config["uid"]] * 4
                and host_attestation["guardian"]["gids"] == [config["gid"]] * 4
                and host_attestation["guardian"]["groups"] == []
                and host_attestation["guardianFlags"]["keepCaps"] == 0
                and host_attestation["guardianFlags"]["parentDeathSignal"] == signal.SIGKILL,
                "guardian final credential/death attestation failed")
        report["guardian"] = host_attestation["guardian"]
        report["guardianFlags"] = host_attestation["guardianFlags"]
        report["order"].append("guardian-minimal-capabilities-measured")
        # Only after BOTH authorities were reduced/read back may the fixed
        # normal Node bootstrap exec. Product main stays behind a second gate.
        os.write(gate_write, b"X")
        bootstrap = read_packet_wait(ready_read, min(deadline, time.monotonic() + 5))
        os.close(ready_read)
        owner_after = verified_metadata(child_pid)
        require(owner_after is not None and key(owner_after) == key(owner)
                and bootstrap.get("stage") == "normal-node-bootstrap-ready"
                and bootstrap.get("runId") == config["runId"]
                and key(bootstrap["identity"]) == key(owner_after)
                and bootstrap["namespace"] == report["namespace"]["pid"]
                and bootstrap["uids"] == [config["uid"]] * 4
                and bootstrap["gids"] == [config["gid"]] * 4
                and bootstrap["noNewPrivs"] == 1 and bootstrap["groups"] == []
                and bootstrap["productGateReleased"] is False
                and bootstrap["descriptors"] == {"rpc": 3, "gate": 4, "ready": 5}
                and set(bootstrap["caps"]) == {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"}
                and all(value == "0000000000000000" for value in bootstrap["caps"].values())
                and bootstrap["bootstrapSha256"] == hashlib.sha256(bounded_read(
                    os.path.join(BASE, "scripts/validation/perception-namespace-node-bootstrap.mjs"), 131072)).hexdigest(),
                "normal Node bootstrap readiness binding mismatch")
        assert_capabilities(owner_after, ())
        owner = owner_after; report["owner"] = owner; report["nodeBootstrap"] = bootstrap
        report["order"].append("normal-node-bootstrap-exec-observed")
        packet_write(3, {**report, "stage": "init-node-ready"}, deadline)
        product_release = read_packet_wait(4, min(deadline, time.monotonic() + 5))
        require(product_release.get("abi") == ABI and product_release.get("runId") == config["runId"]
                and product_release.get("release") == "product", "guardian did not release product main")
        signal.setitimer(signal.ITIMER_REAL, remaining(execution_deadline))
        observer = Observer(config, owner, rpc_parent, {"init": authority, "guardian": report["guardian"],
                            "guardianFlags": report["guardianFlags"], "initParentDeathSignal": parent_death_signal(),
                            "namespace": report["namespace"], "order": report["order"]}, deadline)
        os.write(gate_write, b"G"); os.close(gate_write)
        report["order"].append("normal-node-product-main-released")
        while not report["nodeCloseObserved"]:
            remaining(execution_deadline)
            require(not interrupted, "init interrupted")
            readable = select.select([owner_fd] + ([] if observer.finished else [rpc_parent]), [], [],
                                     min(0.05, remaining(deadline)))[0]
            if rpc_parent in readable:
                try:
                    observer.service()
                except BaseException:
                    if observer.channel.failure_fact is not None:
                        report["faultEvidence"] = {"kind": config["controlledFault"], **observer.channel.failure_fact}
                    raise
            for item in reaps():
                report["reaped"].append(item)
                if item["pid"] == owner["pid"]:
                    report["nodeCloseObserved"] = True
                    report["nodeExitCode"] = item["exitCode"]
        require(observer.finished, "owner died without authenticated finish")
        require(report["nodeExitCode"] == 0, "inner Node failed")
    except BaseException as error:
        report["errors"].append({"stage": report["order"][-1] if report["order"] else "startup",
                                 "type": type(error).__name__, "code": getattr(error, "errno", None)})
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        cleanup_deadline = min(deadline, time.monotonic() + 25)
        # Cleanup errors cannot erase the primary error or receipts.
        try:
            require(namespace_established, "proc namespace was not established; no inventory or containment permitted")
            first = namespace_inventory(cleanup_deadline)
            report["containmentRequired"] = any(item["pid"] != 1 for item in first)
            report["cleanup"] = namespace_cleanup(owner, known, cleanup_deadline)
            for item in report["cleanup"]["reaped"]:
                if owner and item["pid"] == owner["pid"]:
                    report["nodeCloseObserved"] = True
                    report["nodeExitCode"] = item["exitCode"]
            report["success"] = (not report["errors"] and observer is not None and observer.finished
                and report["nodeCloseObserved"] and report.get("nodeExitCode") == 0
                and report["cleanup"]["namespaceEmpty"] and not report["cleanup"]["errors"]
                and not report.get("containmentRequired", True))
            if config["controlledFault"] == "node-owner-death" and report.get("nodeExitCode") == -signal.SIGKILL:
                report["faultEvidence"] = {"kind": "node-owner-death", "nodeExitCode": report["nodeExitCode"],
                                           "nodeCloseObserved": report["nodeCloseObserved"]}
        except BaseException as error:
            report["errors"].append({"stage": "namespace-cleanup", "type": type(error).__name__})
        for channel in channels:
            channel.close()
        try:
            packet_write(3, {**report, "stage": "init-final"}, time.monotonic() + 2)
        except BaseException:
            report["success"] = False
    return 0 if report["success"] else 1


def trustworthy_binary(path):
    value = os.stat(os.path.realpath(path))
    require(value.st_uid == 0 and value.st_mode & 0o6022 == 0 and os.access(path, os.X_OK),
            "privileged prerequisite binary is not root-owned and immutable to runner")
    try:
        capability = os.getxattr(os.path.realpath(path), "security.capability")
    except OSError as error:
        require(error.errno in (errno.ENODATA, errno.ENOTSUP), "binary capability lookup inconclusive")
    else:
        require(not capability, "privileged prerequisite has file capabilities")


CARRIER_GUARD_CODES = {
    "guardian creator identity unavailable": "CREATOR_IDENTITY_UNAVAILABLE",
    "parent-death signal or parent PID mismatch": "PARENT_DEATH_BIND_MISMATCH",
    "minted parent is no longer live": "PARENT_NOT_LIVE",
    "aggregate warden deadline exhausted": "DEADLINE_EXHAUSTED",
    "proc document exceeds observation bound": "PROC_DOCUMENT_BOUND",
    "malformed proc stat delimiter": "PROC_STAT_DELIMITER",
    "incomplete proc identity": "PROC_IDENTITY_INCOMPLETE",
    "invalid proc PID": "PROC_PID_INVALID",
    "proc PID mismatch": "PROC_PID_MISMATCH",
    "missing proc credentials": "PROC_CREDENTIALS_MISSING",
    "invalid supplementary groups": "PROC_GROUPS_INVALID",
    "missing proc capability measurement": "PROC_CAPABILITIES_MISSING",
    "missing NoNewPrivs measurement": "PROC_NNP_MISSING",
    "identity changed during status read": "PROC_STATUS_IDENTITY_CHANGED",
    "sudo carrier birth changed": "CARRIER_BIRTH_CHANGED",
    "sudo carrier UID role mismatch": "CARRIER_UID_ROLE_MISMATCH",
    "sudo carrier GID role mismatch": "CARRIER_GID_ROLE_MISMATCH",
    "sudo carrier creator chain mismatch": "CARRIER_CREATOR_CHAIN_MISMATCH",
    "sudo carrier host namespace mismatch": "CARRIER_NAMESPACE_MISMATCH",
    "sudo carrier executable mismatch": "CARRIER_EXECUTABLE_MISMATCH",
    "sudo carrier executable authority mismatch": "CARRIER_EXECUTABLE_AUTHORITY_MISMATCH",
    "sudo carrier executable grew": "CARRIER_EXECUTABLE_GREW",
    "sudo carrier executable changed during authentication": "CARRIER_EXECUTABLE_CHANGED",
    "sudo carrier facts changed before publication": "CARRIER_PUBLICATION_FACTS_CHANGED",
}


def carrier_diagnostic_fact(value):
    # Copy ONLY previously measured fields. Never fill a missing tuple from config.
    if value is None:
        return None
    result = {}
    for name in ("pid", "ppid", "processGroupId", "sessionId"):
        if type(value.get(name)) is int and value[name] >= 0:
            result[name] = value[name]
    if type(value.get("starttime")) is str and re.fullmatch(r"[0-9]{1,32}", value["starttime"]):
        result["starttime"] = value["starttime"]
    if type(value.get("state")) is str and re.fullmatch(r"[RSDZTtWXxIKP]", value["state"]):
        result["state"] = value["state"]
    for name in ("uids", "gids"):
        if type(value.get(name)) is list and len(value[name]) == 4 and all(type(item) is int and item >= 0 for item in value[name]):
            result[name] = list(value[name])
    return result


def carrier_diagnostic_link(diagnostic, role, path, namespace):
    value = os.readlink(path)  # EXACT existing read, at its existing short-circuit position.
    if namespace and re.fullmatch(r"pid:\[[0-9]+\]", value):
        fact = {"value": value}
    elif not namespace and value == "/usr/bin/sudo":
        fact = {"value": value}
    else:
        encoded = value.encode("utf-8", "surrogatepass")
        fact = {"value": None, "classification": "unrecognized", "bytes": len(encoded),
                "sha256": hashlib.sha256(encoded).hexdigest()}
    diagnostic["facts"][role] = fact
    return value


def carrier_diagnostic_error(error):
    allowed_types = ("RuntimeError", "OSError", "PermissionError", "FileNotFoundError", "ProcessLookupError",
                     "TimeoutError", "UnicodeDecodeError", "KeyError", "TypeError", "ValueError")
    name = type(error).__name__
    code = CARRIER_GUARD_CODES.get(str(error), "UNCLASSIFIED_GUARD") if type(error) is RuntimeError else "OS_OR_PARSE_FAILURE"
    number = getattr(error, "errno", None)
    return {"type": name if name in allowed_types else "OtherError", "guardCode": code,
            "errno": number if type(number) is int and 0 <= number <= 4095 else None}


def capture_sudo_carrier_birth(creator, config, deadline, descriptors, diagnostic):
    # Observe before dropping privilege, on the existing authenticated FD.
    diagnostic["stage"] = "carrier-metadata"
    remaining(deadline)
    carrier = verified_metadata(creator["pid"])
    diagnostic["facts"]["carrier"] = carrier_diagnostic_fact(carrier)
    diagnostic["stage"] = "carrier-birth-identity"
    require(carrier is not None and key(carrier) == key(creator) and carrier["ppid"] == creator["ppid"]
            and carrier["state"] not in TERMINAL, "sudo carrier birth changed")
    diagnostic["stage"] = "carrier-uid-role"
    require(carrier["uids"] == [config["uid"], 0, 0, 0], "sudo carrier UID role mismatch")
    gids = carrier["gids"]
    diagnostic["stage"] = "carrier-gid-role"
    gid_roles = {tuple([config["gid"]] * 4): "owner-group",
                 (config["gid"], 0, 0, 0): "root-group", (0, 0, 0, 0): "all-root-group"}
    require(tuple(gids) in gid_roles, "sudo carrier GID role mismatch")
    gid_role = gid_roles[tuple(gids)]
    diagnostic["stage"] = "launcher-metadata"
    launcher = verified_metadata(carrier["ppid"])
    diagnostic["facts"]["launcher"] = carrier_diagnostic_fact(launcher)
    diagnostic["stage"] = "guardian-identity"
    guardian = identity(os.getpid())
    diagnostic["facts"]["guardian"] = carrier_diagnostic_fact(guardian)
    diagnostic["stage"] = "creator-chain"
    require(launcher is not None and launcher["state"] not in TERMINAL
            and launcher["uids"] == [config["uid"]] * 4 and launcher["gids"] == [config["gid"]] * 4
            and guardian is not None and guardian["ppid"] == carrier["pid"], "sudo carrier creator chain mismatch")
    diagnostic["stage"] = "host-namespace"
    namespace = carrier_diagnostic_link(diagnostic, "carrierNamespace", "/proc/%d/ns/pid" % carrier["pid"], True)
    require(re.fullmatch(r"pid:\[[0-9]+\]", namespace)
            and namespace == carrier_diagnostic_link(diagnostic, "launcherNamespace", "/proc/%d/ns/pid" % launcher["pid"], True)
            and namespace == carrier_diagnostic_link(diagnostic, "guardianNamespace", "/proc/self/ns/pid", True), "sudo carrier host namespace mismatch")
    diagnostic["stage"] = "executable-link"
    executable = carrier_diagnostic_link(diagnostic, "carrierExecutable", "/proc/%d/exe" % carrier["pid"], False)
    diagnostic["stage"] = "executable-role"
    require(executable == "/usr/bin/sudo", "sudo carrier executable mismatch")
    diagnostic["stage"] = "executable-open"
    descriptor = os.open("/usr/bin/sudo", os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    descriptors.append(descriptor)  # Register before validation can throw.
    try:
        diagnostic["stage"] = "executable-metadata"
        metadata = os.fstat(descriptor)
        active_executable = os.stat("/proc/%d/exe" % carrier["pid"])
        diagnostic["stage"] = "executable-authority"
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_gid == 0
                and metadata.st_mode & 0o4000 and not metadata.st_mode & 0o2022
                and metadata.st_mode & 0o111 and 0 < metadata.st_size <= 16 * 1024 * 1024
                and (metadata.st_dev, metadata.st_ino) == (active_executable.st_dev, active_executable.st_ino),
                "sudo carrier executable authority mismatch")
        digest, size = hashlib.sha256(), 0
        diagnostic["stage"] = "executable-hash"
        while True:
            remaining(deadline)
            chunk = os.read(descriptor, min(65536, metadata.st_size - size + 1))
            if not chunk:
                break
            size += len(chunk)
            require(size <= metadata.st_size, "sudo carrier executable grew")
            digest.update(chunk)
        diagnostic["stage"] = "executable-readback"
        after = os.fstat(descriptor)
        require(size == metadata.st_size and (after.st_dev, after.st_ino, after.st_size, after.st_mode,
                after.st_uid, after.st_gid, after.st_mtime_ns, after.st_ctime_ns) == (metadata.st_dev, metadata.st_ino,
                metadata.st_size, metadata.st_mode, metadata.st_uid, metadata.st_gid, metadata.st_mtime_ns,
                metadata.st_ctime_ns), "sudo carrier executable changed during authentication")
        file_fact = {"path": executable, "dev": metadata.st_dev, "ino": metadata.st_ino,
                     "bytes": size, "mode": metadata.st_mode, "uid": metadata.st_uid, "gid": metadata.st_gid,
                     "sha256": digest.hexdigest()}
    finally:
        os.close(descriptor)
        descriptors.remove(descriptor)
    diagnostic["stage"] = "publication-recheck"
    remaining(deadline)
    active_executable = os.stat("/proc/%d/exe" % carrier["pid"])
    verified = verified_metadata(carrier["pid"])
    diagnostic["facts"]["carrierRecheck"] = carrier_diagnostic_fact(verified)
    require(verified is not None and key(verified) == key(carrier) and verified["ppid"] == launcher["pid"]
            and verified["state"] not in TERMINAL and verified["uids"] == carrier["uids"]
            and verified["gids"] == carrier["gids"]
            and carrier_diagnostic_link(diagnostic, "carrierExecutableRecheck", "/proc/%d/exe" % carrier["pid"], False) == executable
            and (active_executable.st_dev, active_executable.st_ino)
                == (file_fact["dev"], file_fact["ino"])
            and carrier_diagnostic_link(diagnostic, "carrierNamespaceRecheck", "/proc/%d/ns/pid" % carrier["pid"], True) == namespace
            and key(identity(launcher["pid"])) == key(launcher)
            and key(identity(os.getpid())) == key(guardian), "sudo carrier facts changed before publication")
    diagnostic["stage"] = "complete"
    diagnostic["completed"] = True
    return {"schemaVersion": "perception-sudo-carrier-birth/v1", "sourceSha256": SCRIPT_SHA256,
            "measurement": "privileged-before-drop", "carrierIdentity": verified,
            "launcherIdentity": launcher, "guardianIdentity": guardian, "hostNamespace": namespace,
            "gidRole": gid_role, "executable": file_fact}


def host_main():
    # sudo preserves only stdio by default. FD1 is framing-only; duplicate it
    # privately HERE, never request sudo -C or a sudoers/global security change.
    os.dup2(1, 3, inheritable=True)
    config = read_config(0)
    require(os.getuid() == 0 and int(os.environ.get("SUDO_UID", "-1")) == config["uid"]
            and int(os.environ.get("SUDO_GID", "-1")) == config["gid"], "sudo owner credentials mismatch")
    deadline = deadline_from_epoch(config["deadlineAt"])
    signal.signal(signal.SIGALRM, alarm_handler)
    execution_deadline = deadline - 25
    signal.setitimer(signal.ITIMER_REAL, remaining(execution_deadline))
    report = {"abi": ABI, "runId": config["runId"], "sourceCommit": config["sourceCommit"], "stage": "guardian",
              "success": False, "errors": [], "reaped": [], "signals": [], "unshareCloseObserved": False,
              "deadlineAt": config["deadlineAt"], "innerDeadlineAt": config["innerDeadlineAt"],
              "wardenSha256": SCRIPT_SHA256}
    minted, descriptors = {}, []
    unshare_pid, init_final = None, None
    interrupted = []
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda signum, _frame: interrupted.append(signum))
    try:
        report["carrierBirthDiagnostic"] = {"schemaVersion": "perception-sudo-carrier-diagnostic/v1",
                                            "stage": "creator-identity", "completed": False, "facts": {}}
        creator = identity(os.getppid())
        report["carrierBirthDiagnostic"]["facts"]["creator"] = carrier_diagnostic_fact(creator)
        require(creator is not None and creator["pid"] > 1, "guardian creator identity unavailable")
        report["carrierBirthDiagnostic"]["stage"] = "parent-death-bind"
        bind_parent_death(creator)
        report["carrierBirthFacts"] = capture_sudo_carrier_birth(creator, config, execution_deadline, descriptors,
                                                              report["carrierBirthDiagnostic"])
        for binary in ("/usr/bin/unshare", "/usr/bin/python3"):
            trustworthy_binary(binary)
        prctl(36, 1)  # PR_SET_CHILD_SUBREAPER; only our forked namespace children.
        configuration_read, configuration_write = os.pipe()
        receipt_read, receipt_write = os.pipe()
        release_read, release_write = os.pipe()
        fork_read, fork_write = os.pipe()
        guardian_fork_identity = identity(os.getpid())
        require(guardian_fork_identity is not None, "guardian fork identity unavailable")
        unshare_pid = os.fork()
        if unshare_pid == 0:
            try:
                os.close(configuration_write); os.close(receipt_read); os.close(release_write); os.close(fork_write)
                require(os.read(fork_read, 1) == b"G", "unshare fork gate denied")
                os.close(fork_read)
                own = identity(os.getpid())
                bind_parent_death(guardian_fork_identity)
                # Duplicate above the destination range before mapping fixed FDs.
                import fcntl
                sources = [fcntl.fcntl(value, fcntl.F_DUPFD_CLOEXEC, 10)
                           for value in (configuration_read, receipt_write, release_read)]
                for source, destination in zip(sources, (0, 3, 4)):
                    os.dup2(source, destination, inheritable=True)
                # Unshare, Python init and normal Node may only log to FD2.
                # No product/bootstrap process retains the outer receipt pipe.
                os.dup2(2, 1, inheritable=True)
                for descriptor in range(5, min(4096, os.sysconf("SC_OPEN_MAX"))):
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
                os.execve("/usr/bin/unshare", ["/usr/bin/unshare", "--pid", "--fork", "--mount", "--propagation", "private",
                    "--kill-child=SIGKILL", "/usr/bin/python3", "-I", "-S", SCRIPT, "--init", str(own["pid"]), own["starttime"]],
                    {"LANG": "C.UTF-8"})
            except BaseException:
                os._exit(126)
        os.close(configuration_read); os.close(receipt_write); os.close(release_read); os.close(fork_read)
        unshare_identity = verified_metadata(unshare_pid)
        require(unshare_identity is not None and unshare_identity["ppid"] == os.getpid(), "unshare fork identity unavailable")
        unshare_fd = os.pidfd_open(unshare_pid, 0)
        require(key(identity(unshare_pid)) == key(unshare_identity), "unshare identity changed after pidfd open")
        descriptors.extend([receipt_read, release_write, configuration_write, unshare_fd])
        minted[key(unshare_identity)] = unshare_identity
        report["unshareIdentity"] = unshare_identity
        os.write(fork_write, b"G"); os.close(fork_write)
        payload = json.dumps(config, separators=(",", ":")).encode("utf8") + b"\n"
        require(len(payload) <= 131072, "init configuration exceeds bound")
        view = memoryview(payload)
        while view:
            require(select.select([], [configuration_write], [], min(2, remaining(deadline)))[1], "init configuration timeout")
            view = view[os.write(configuration_write, view):]
        os.close(configuration_write); descriptors.remove(configuration_write)
        buffer = bytearray()
        birth = read_packet_wait(receipt_read, deadline, buffer)
        require(birth.get("stage") == "init-minted" and birth.get("abi") == ABI and birth.get("runId") == config["runId"],
                "unexpected init birth receipt")
        host_init = verified_metadata(birth["hostIdentity"]["pid"])
        require(host_init is not None and key(host_init) == key(birth["hostIdentity"])
                and host_init["ppid"] == unshare_identity["pid"], "init host ancestry mismatch")
        init_anchor = mint_init_stop_anchor(host_init, birth, unshare_identity, descriptors, deadline)
        minted[key(host_init)] = host_init
        report["initIdentity"] = host_init
        ready = read_packet_wait(receipt_read, deadline, buffer)
        if ready.get("stage") == "init-final":
            require(ready.get("success") is False and ready.get("runId") == config["runId"], "invalid premature init final")
            init_final = ready
            report["initFinal"] = ready
            raise RuntimeError("init failed before ready")
        require(ready.get("stage") == "init-ready" and ready.get("abi") == ABI and ready.get("runId") == config["runId"]
                and key(ready["hostIdentity"]) == key(host_init), "unexpected init bootstrap receipt")
        assert_capabilities(verified_metadata(host_init["pid"]), INIT_CAPS)
        assert_capabilities(ready["owner"], ())
        # This is the ONLY child list read in the host namespace. No general
        # host inventory or environment access. Product is still gated.
        children = bounded_read("/proc/%d/task/%d/children" % (host_init["pid"], host_init["pid"]), 128).split()
        require(len(children) == 1 and children[0].isdigit(), "gated init must have exactly one bootstrap child")
        host_node_pid = int(children[0])
        host_node_fd = os.pidfd_open(host_node_pid, 0)
        try:
            host_node = verified_metadata(host_node_pid)
            require(host_node is not None and host_node["ppid"] == host_init["pid"]
                    and host_node["starttime"] == ready["owner"]["starttime"]
                    and host_node["uids"] == [config["uid"]] * 4 and host_node["gids"] == [config["gid"]] * 4
                    and host_node["groups"] == [], "bootstrap host/namespace identity mismatch")
            assert_capabilities(host_node, ())
            status = bounded_read("/proc/%d/status" % host_node_pid, STATUS_LIMIT).decode("ascii", "strict")
            fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
            namespace_pids = fields.get("NSpid", "").split()
            require(len(namespace_pids) >= 2 and len(namespace_pids) <= 32
                    and all(value.isdigit() for value in namespace_pids)
                    and int(namespace_pids[0]) == host_node_pid and int(namespace_pids[-1]) == ready["owner"]["pid"],
                    "bootstrap namespace PID binding mismatch")
            node_namespace = os.readlink("/proc/%d/ns/pid" % host_node_pid)
            require(node_namespace == ready["namespace"]["pid"] and key(identity(host_node_pid)) == key(host_node),
                    "bootstrap PID namespace or identity changed")
            report["nodeHostIdentity"] = host_node
            report["nodeNamespacePids"] = [int(value) for value in namespace_pids]
            report["nodePidNamespace"] = node_namespace
        finally:
            os.close(host_node_fd)
        guardian = drop_guardian(config["uid"], config["gid"], creator)
        report["guardianIdentity"] = guardian
        report["guardianFlags"] = {"keepCaps": keep_capabilities(), "parentDeathSignal": parent_death_signal(),
                                   "parentIdentity": {"pid": creator["pid"], "starttime": creator["starttime"]}}
        packet_write(release_write, {"abi": ABI, "runId": config["runId"], "release": "bootstrap-only", "guardian": guardian,
                                    "guardianFlags": report["guardianFlags"]}, deadline)
        node_ready = read_packet_wait(receipt_read, min(deadline, time.monotonic() + 5), buffer)
        require(node_ready.get("stage") == "init-node-ready" and node_ready.get("runId") == config["runId"]
                and key(node_ready["hostIdentity"]) == key(host_init)
                and key(node_ready["owner"]) == key(ready["owner"]), "normal Node exec readiness receipt mismatch")
        host_node_after = verified_metadata(host_node_pid)
        require(host_node_after is not None and key(host_node_after) == key(host_node)
                and host_node_after["ppid"] == host_init["pid"]
                and host_node_after["uids"] == [config["uid"]] * 4
                and host_node_after["gids"] == [config["gid"]] * 4
                and os.readlink("/proc/%d/ns/pid" % host_node_pid) == node_namespace,
                "execed normal Node host anchor changed")
        assert_capabilities(host_node_after, ())
        report["nodeHostIdentity"] = host_node_after
        ready = node_ready
        report["initBootstrap"] = ready
        packet_write(3, {**report, "stage": "guardian-ready"}, deadline)
        if config["controlledFault"] == "guardian-stop":
            signal.raise_signal(signal.SIGSTOP)  # Owner must use its retained native pidfd.
        # Owner opens/rechecks the attested host pidfds while Node is STILL a
        # normal trusted bootstrap. Only this fixed gate acknowledgement exists.
        guardian_product_gate(config, report, init_anchor, release_write, execution_deadline, deadline)
        os.close(release_write); descriptors.remove(release_write)
        signal.setitimer(signal.ITIMER_REAL, remaining(execution_deadline))
        last_heartbeat = time.monotonic()
        receipt_eof = False
        while not report["unshareCloseObserved"]:
            remaining(execution_deadline)
            require(not interrupted, "guardian interrupted")
            require(time.monotonic() - last_heartbeat <= 5, "outer launcher heartbeat missing")
            pending = buffered_packet(buffer) if init_final is None else None
            readable = select.select([0] + ([] if receipt_eof else [receipt_read]), [], [], 0 if pending is not None else
                                     min(0.05, remaining(deadline)))[0]
            if 0 in readable:
                data = os.read(0, 64)
                require(data and all(value == ord("P") for value in data), "outer launcher died or aborted")
                last_heartbeat = time.monotonic()
            if pending is not None or receipt_read in readable:
                if init_final is not None:
                    extra = os.read(receipt_read, FRAME_LIMIT + 4)
                    require(not extra and not buffer, "extra root frame after init final")
                    receipt_eof = True
                    item = None
                else:
                    item = pending if pending is not None else packet_read(receipt_read, buffer)
                if item is not None:
                    require(item.get("stage") == "init-final" and item.get("runId") == config["runId"], "invalid init final receipt")
                    init_final = item
                    report["initFinal"] = item
                    require(not buffer, "extra or truncated root frame after init final")
            for item in reaps():
                report["reaped"].append(item)
                if item["pid"] == unshare_pid:
                    report["unshareCloseObserved"] = True
                    report["unshareExitCode"] = item["exitCode"]
        require(init_final is not None and not buffer, "missing or truncated init receipt")
        if not receipt_eof:
            require(select.select([receipt_read], [], [], min(2, remaining(deadline)))[0], "init receipt EOF timeout")
            require(not os.read(receipt_read, FRAME_LIMIT + 4), "extra root frame after init close")
        require(report["unshareExitCode"] == 0 and init_final.get("success") is True, "inner or init failed")
    except BaseException as error:
        if report.get("carrierBirthDiagnostic", {}).get("completed") is False:
            report["carrierBirthDiagnostic"]["error"] = carrier_diagnostic_error(error)
        report["errors"].append({"type": type(error).__name__, "code": getattr(error, "errno", None)})
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        cleanup_deadline = time.monotonic() + min(25, max(0, deadline - time.monotonic()))
        try:
            for requested in (signal.SIGTERM, signal.SIGKILL):
                for value in reversed(list(minted.values())):
                    remaining(cleanup_deadline)
                    report["signals"].append({"pid": value["pid"], "starttime": value["starttime"],
                                              "signal": requested, **pidfd_signal(value, requested, cleanup_deadline)})
                while remaining(cleanup_deadline) > 0:
                    report["reaped"].extend(reaps())
                    states = [{"pid": value["pid"], "starttime": value["starttime"], "current": identity(value["pid"])}
                              for value in minted.values()]
                    report["identityStates"] = states
                    if all(item["current"] is None or key(item["current"]) != (item["pid"], item["starttime"])
                           or item["current"]["state"] in TERMINAL for item in states):
                        report["mintedProcessesTerminal"] = True
                        break
                    if requested == signal.SIGTERM:
                        break
                    time.sleep(min(0.05, remaining(cleanup_deadline)))
                if report.get("mintedProcessesTerminal"):
                    break
        except BaseException as error:
            report["errors"].append({"stage": "guardian-cleanup", "type": type(error).__name__})
        report["success"] = (not report["errors"] and report["unshareCloseObserved"] and report.get("unshareExitCode") == 0
                             and report.get("mintedProcessesTerminal", False) and init_final is not None and init_final.get("success") is True)
        for descriptor in descriptors:
            os.close(descriptor)
        try:
            packet_write(3, {**report, "stage": "guardian-final"}, time.monotonic() + 2)
        except BaseException:
            report["success"] = False
    return 0 if report["success"] else 1


if __name__ == "__main__":
    require(sys.platform == "linux", "Linux namespace prerequisites required")
    if sys.argv[1:] == ["--host"]:
        sys.exit(host_main())
    require(len(sys.argv) == 4 and sys.argv[1] == "--init" and sys.argv[2].isdigit()
            and sys.argv[3].isdigit(), "unsupported warden entry point")
    sys.exit(init_main({"pid": int(sys.argv[2]), "starttime": sys.argv[3]}))
