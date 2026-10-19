"""Fixed disposable CI cgroup authority; not a security sandbox or exec RPC.

Admission moves only this helper's own getpid(), then executes the closed Node
bootstrap after restoring normal CI credentials. No foreign PID migration.
"""
import ctypes
import hashlib
import json
import math
import os
import re
import select
import signal
import stat
import sys
import time

ABI = "perception-consumer-cgroup/v1"
BASE = "/sys/fs/cgroup"
LIMIT = 65536
RUN = re.compile(r"pidfd-cgroup-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
TERMINAL = ("Z", "X", "x")
ENV_NAMES = frozenset((
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "CI", "RUNNER_TEMP",
    "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "NEXT_TELEMETRY_DISABLED",
    "APOLLO_API_ENVIRONMENT", "V2_DATABASE_URL", "APOLLO_LIBRARY_EVIDENCE_ROOT",
    "APOLLO_V2_ARTIFACT_STORAGE_DRIVER", "APOLLO_V2_ARTIFACT_ROOT",
    "APOLLO_PROTECTED_PAYLOAD_KEY_ID", "APOLLO_PROTECTED_PAYLOAD_KEY",
    "APOLLO_OCR_VIDEO_E2E", "APOLLO_PERCEPTION_HTTP_E2E", "APOLLO_TEMPORAL_VIDEO_E2E",
    "APOLLO_TEMPORAL_HTTP_E2E", "APOLLO_OCR_TESSERACT", "APOLLO_OCR_TESSDATA",
    "APOLLO_OCR_FFMPEG", "APOLLO_TEMPORAL_FFMPEG", "APOLLO_OCR_FFPROBE", "APOLLO_TEMPORAL_FFPROBE",
    "FFMPEG_BIN", "FFPROBE_BIN", "APOLLO_PERCEPTION_PIDFD_ADDON", "APOLLO_PERCEPTION_PIDFD_PROVENANCE",
    "APOLLO_PERCEPTION_PIDFD_SHA256", "APOLLO_PERCEPTION_PIDFD_ROOT", "APOLLO_PERCEPTION_CONSUMER_RUN_ID",
    "APOLLO_PERCEPTION_CGROUP_SCOPE", "APOLLO_PERCEPTION_JOB_DEADLINE_MS",
    "APOLLO_DASHBOARD_RUNTIME_E2E", "APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT",
    "APOLLO_DASHBOARD_RUNTIME_SERVER_MODE", "APOLLO_DASHBOARD_CFT157_LINUX_ROOT",
))


def require(value, message):
    if not value:
        raise RuntimeError(message)


def remaining(end):
    saldo = end - time.monotonic()
    require(saldo > 0, "cgroup aggregate deadline exhausted")
    return saldo


def read_bounded(path):
    with open(path, "rb", buffering=0) as source:
        raw = source.read(LIMIT + 1)
    require(len(raw) <= LIMIT, "cgroup metadata byte bound")
    return raw.decode("utf8", "strict")


def process_identity(pid):
    require(type(pid) is int and pid > 0, "invalid cgroup identity PID")
    text = read_bounded("/proc/%d/stat" % pid)
    boundary = text.rfind(")")
    require(re.match(r"^[1-9][0-9]* \(", text) and boundary > text.index("(")
            and text[boundary:boundary + 2] == ") ", "invalid cgroup proc stat")
    parts = text[boundary + 2:].split()
    require(len(parts) >= 50 and re.fullmatch(r"[RSDZTtWXxIKP]", parts[0])
            and re.fullmatch(r"[0-9]+", parts[19])
            and all(re.fullmatch(r"[0-9]+", value) for value in parts[1:4]), "incomplete cgroup identity")
    require(int(text.split(" ", 1)[0]) == pid, "cgroup proc PID mismatch")
    return {"pid": pid, "starttime": parts[19], "state": parts[0], "ppid": int(parts[1])}


def credentials(pid):
    fields = {}
    for line in read_bounded("/proc/%d/status" % pid).splitlines():
        if ":" in line:
            name, value = line.split(":", 1)
            require(name not in fields, "duplicate status field")
            fields[name] = value.strip()
    result = {}
    for name in ("Uid", "Gid"):
        values = fields.get(name, "").split()
        require(len(values) == 4 and all(re.fullmatch(r"[0-9]+", value) for value in values), "missing cgroup credentials")
        result[name.lower() + "s"] = list(map(int, values))
    for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
        require(re.fullmatch(r"[0-9a-fA-F]{16}", fields.get(name, "")), "missing cgroup capability measurement")
        result[name] = fields[name].lower()
    require(fields.get("NoNewPrivs") in ("0", "1"), "missing cgroup NNP measurement")
    result["NoNewPrivs"] = int(fields["NoNewPrivs"])
    groups = fields.get("Groups", "").split()
    require("Groups" in fields and len(groups) <= 256 and all(re.fullmatch(r"[0-9]+", value) for value in groups), "invalid supplementary groups")
    result["groups"] = list(map(int, groups))
    return result


def key(value):
    return (value["pid"], value["starttime"])


def membership(pid):
    lines = read_bounded("/proc/%d/cgroup" % pid).splitlines()
    rows = [value[3:] for value in lines if value.startswith("0::")]
    require(len(rows) == 1, "missing unique cgroup2 membership")
    path = rows[0]
    require(path.startswith("/") and len(path) <= 1024 and "\0" not in path
            and all(part not in (".", "..") for part in path.split("/")), "invalid cgroup membership path")
    return path


def strict_json(raw):
    def pairs(values):
        result = {}
        for name, value in values:
            require(name not in result, "duplicate cgroup JSON field")
            result[name] = value
        return result

    def number(value):
        result = float(value)
        require(math.isfinite(result), "nonfinite cgroup JSON number")
        return result

    return json.loads(raw, object_pairs_hook=pairs, parse_float=number,
                      parse_constant=lambda _: require(False, "nonfinite cgroup JSON constant"))


def read_config(fd, end):
    raw = bytearray()
    while b"\n" not in raw:
        require(select.select([fd], [], [], remaining(end))[0], "cgroup configuration deadline")
        chunk = os.read(fd, 16384)
        require(chunk, "cgroup configuration EOF")
        raw.extend(chunk)
        require(len(raw) <= LIMIT, "cgroup configuration byte bound")
    first, extra = bytes(raw).split(b"\n", 1)
    require(not extra, "cgroup configuration pipelining prohibited")
    return strict_json(first.decode("utf8", "strict"))


def validate_config(value, mode):
    require(mode in ("create", "remove", "guardian", "admit"), "unknown cgroup operation")
    expected = {"abi", "runId", "sourceCommit", "helperSha256", "owner", "deadlineAt"}
    if mode in ("remove", "guardian", "admit"):
        expected.add("scope")
    if mode == "admit":
        expected.update(("consumer", "node", "nodeSha256", "bootstrapSha256", "environment"))
    if mode == "guardian":
        expected.add("controlledStop")
    require(type(value) is dict and set(value) == expected, "closed cgroup configuration required")
    require(value["abi"] == ABI and type(value["runId"]) is str and RUN.fullmatch(value["runId"]), "invalid cgroup run identity")
    for field, length in (("sourceCommit", 40), ("helperSha256", 64)):
        require(type(value[field]) is str and re.fullmatch(r"[a-f0-9]{%d}" % length, value[field]), "invalid cgroup source pin")
    require(type(value["deadlineAt"]) is int and time.time() * 1000 < value["deadlineAt"] <= time.time() * 1000 + 1200000,
            "invalid cgroup absolute deadline")
    owner = value["owner"]
    if mode == "guardian":
        require(type(value["controlledStop"]) is bool, "guardian fault must be a boolean fixed fixture")
    if mode in ("remove", "guardian", "admit"):
        scope = value["scope"]
        require(type(scope) is dict and set(scope) == {"path", "membership", "directory", "kill", "runId"}
                and scope["runId"] == value["runId"], "closed cgroup scope required")
        require(type(scope["path"]) is str and scope["path"].startswith(BASE + "/")
                and len(scope["path"]) <= 1200 and "\0" not in scope["path"]
                and "\\" not in scope["path"] and "\n" not in scope["path"]
                and all(part and part not in (".", "..") for part in scope["path"].split("/")[1:])
                and scope["path"].endswith("/apollo-" + value["runId"])
                and scope["membership"] == scope["path"][len(BASE):], "invalid cgroup scope path")
        for field in ("directory", "kill"):
            require(type(scope[field]) is dict and set(scope[field]) == {"dev", "ino"}
                    and all(type(scope[field][name]) is int and scope[field][name] >= (1 if name == "ino" else 0)
                            for name in ("dev", "ino")), "invalid cgroup inode seal")
    if mode == "admit":
        validate_consumer(value["consumer"])
        validate_environment(value["environment"])
    require(type(owner) is dict and set(owner) == {"pid", "starttime", "uid", "gid", "namespace"}, "closed cgroup owner identity required")
    require(all(type(owner[name]) is int and owner[name] > 0 for name in ("pid", "uid", "gid"))
            and type(owner["starttime"]) is str and re.fullmatch(r"[0-9]+", owner["starttime"])
            and type(owner["namespace"]) is str and re.fullmatch(r"pid:\[[0-9]+\]", owner["namespace"]), "invalid cgroup owner")
    with open(__file__, "rb") as source:
        raw = source.read(1048577)
        require(len(raw) <= 1048576 and hashlib.sha256(raw).hexdigest() == value["helperSha256"], "external cgroup helper pin mismatch")
    return value


def validate_environment(environment):
    require(type(environment) is dict and set(environment) <= ENV_NAMES
            and all(type(value) is str and "\0" not in value for value in environment.values()), "invalid normal consumer environment")
    require(sum(len(name.encode("utf8")) + len(value.encode("utf8")) for name, value in environment.items()) <= 131072,
            "normal consumer environment bound")


def validate_consumer(consumer):
    require(type(consumer) is dict and set(consumer) == {"mode", "args"}, "closed consumer declaration required")
    mode, args = consumer["mode"], consumer["args"]
    require(type(mode) is str and type(args) is list and all(type(value) is str for value in args), "invalid consumer arguments")
    suites = {"tests/v2/tesseract-ocr-video-adapter.integration.mjs", "tests/v2/ffmpeg-temporal-video-analyzer.integration.mjs",
              "tests/v2/prisma-perception-producer-admission.integration.mjs", "tests/v2/prisma-perception-producer-worker.integration.mjs",
              "tests/v2/prisma-perception-producer-http.integration.mjs", "tests/v2/prisma-director-ocr.integration.mjs",
              "tests/v2/prisma-temporal-producer.integration.mjs", "tests/v2/prisma-face-producer.integration.mjs",
              "tests/v2/prisma-server-perception-snapshot.integration.mjs", "tests/v2/prisma-director-server-perception.integration.mjs", "tests/v2/server-perception-snapshot-server.integration.mjs"}
    require((mode == "unit" and not args)
            or (mode in ("dashboard", "acquisition") and not args)
            or (mode == "fixture" and len(args) == 1 and args[0] in
                ("wait", "setsid-reparent", "zombie", "member-exit", "guardian-stop-owner-death"))
            or (mode == "gates" and args == ["tests/v2/perception-namespace-observer.integration.mjs"])
            or (mode == "namespace" and len(args) in (1, 2) and args[0] in suites
                and (len(args) == 1 and args[0] != "tests/v2/prisma-face-producer.integration.mjs"
                     or args == ["tests/v2/prisma-face-producer.integration.mjs", "publish-race|face control"])), "arbitrary consumer command prohibited")
    return mode, args


def assert_cgroup2():
    require(os.path.realpath(BASE) == BASE, "cgroup mount ancestor symlink forbidden")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.statfs.argtypes = (ctypes.c_char_p, ctypes.c_void_p)
    libc.statfs.restype = ctypes.c_int
    require(ctypes.sizeof(ctypes.c_long) == 8, "unsupported cgroup statfs ABI")
    buffer = (ctypes.c_long * 32)()
    require(libc.statfs(BASE.encode("ascii"), buffer) == 0 and buffer[0] == 0x63677270, "cgroup2 filesystem required")


def root_scope(config, create):
    require(os.getuid() == 0 and os.geteuid() == 0, "fixed cgroup root helper requires sudo")
    require(int(os.environ.get("SUDO_UID", "-1")) == config["owner"]["uid"]
            and int(os.environ.get("SUDO_GID", "-1")) == config["owner"]["gid"], "cgroup sudo owner mismatch")
    if create or "consumer" in config:
        # Authenticate the actual fixed helper's creator chain, not a numeric
        # PID named by a same-UID caller. Removal instead authenticates the
        # archived scope after its original owner is terminal.
        ancestry = []
        current = process_identity(os.getpid())
        for _ in range(16):
            ancestry.append(current)
            if key(current) == key(config["owner"]):
                break
            require(current["ppid"] > 0 and current["state"] not in TERMINAL, "cgroup creator chain unavailable")
            parent = process_identity(current["ppid"])
            require(int(parent["starttime"]) <= int(current["starttime"]), "cgroup creator PID reused")
            current = parent
        require(key(current) == key(config["owner"]), "cgroup owner is not the measured ancestor")
        for previous in ancestry:
            actual = process_identity(previous["pid"])
            require(key(actual) == key(previous) and actual["ppid"] == previous["ppid"]
                    and actual["state"] not in TERMINAL, "cgroup creator chain changed")
    assert_cgroup2()
    if create:
        owner = config["owner"]
        before = process_identity(owner["pid"])
        require(key(before) == key(owner) and before["state"] not in TERMINAL, "cgroup owner not live")
        status = credentials(owner["pid"])
        require(status["uids"] == [owner["uid"]] * 4 and status["gids"] == [owner["gid"]] * 4, "cgroup owner credential mismatch")
        require(os.readlink("/proc/%d/ns/pid" % owner["pid"]) == owner["namespace"], "cgroup owner namespace mismatch")
        parent = membership(owner["pid"])
        require(key(process_identity(owner["pid"])) == key(owner), "cgroup owner changed before creation")
        path = os.path.join(BASE, parent.lstrip("/"), "apollo-" + config["runId"])
        require(os.path.realpath(os.path.dirname(path)) == os.path.dirname(path), "cgroup parent symlink forbidden")
        os.mkdir(path, 0o755)
        created = True
    else:
        scope = config["scope"]
        require(type(scope) is dict and set(scope) == {"path", "membership", "directory", "kill", "runId"}
                and scope["runId"] == config["runId"], "invalid sealed cgroup scope")
        path = scope["path"]
        require(type(path) is str and path.startswith(BASE + "/") and path.endswith("/apollo-" + config["runId"])
                and os.path.realpath(path) == path, "invalid sealed cgroup path")
        created = False
    directory = os.lstat(path)
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and not (directory.st_mode & 0o022), "cgroup directory authority invalid")
    require(read_bounded(path + "/cgroup.type").strip() == "domain", "normal cgroup domain required")
    for name in ("cgroup.procs", "cgroup.threads"):
        metadata = os.lstat(path + "/" + name)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and not (metadata.st_mode & 0o022), "product can migrate cgroup membership")
    kill = path + "/cgroup.kill"
    if created:
        os.chown(kill, config["owner"]["uid"], config["owner"]["gid"])
        os.chmod(kill, 0o200)  # This grants containment, not a security sandbox.
    metadata = os.lstat(kill)
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == config["owner"]["uid"]
            and stat.S_IMODE(metadata.st_mode) == 0o200, "invalid kill-only grant")
    result = {"path": path, "membership": path[len(BASE):], "runId": config["runId"],
              "directory": {"dev": directory.st_dev, "ino": directory.st_ino},
              "kill": {"dev": metadata.st_dev, "ino": metadata.st_ino}}
    if not created:
        require(result == config["scope"], "cgroup scope inode or membership changed")
    return result


def assert_empty(scope):
    events = dict(line.split() for line in read_bounded(scope["path"] + "/cgroup.events").splitlines())
    require(events.get("populated") == "0", "cgroup still populated")
    require(not read_bounded(scope["path"] + "/cgroup.procs").strip(), "cgroup live membership not empty")
    require(not any(entry.is_dir(follow_symlinks=False) for entry in os.scandir(scope["path"])), "unknown descendant cgroup")
    # Neither observation proves zombie reaping or any ChildProcess close.
    return {"populated": 0, "liveMembershipEmpty": True, "zombieReapingEstablished": False}


def emit(document, end):
    raw = (json.dumps(document, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
    require(len(raw) <= LIMIT, "cgroup receipt frame bound")
    while raw:
        require(select.select([], [1], [], remaining(end))[1], "cgroup receipt deadline")
        raw = raw[os.write(1, raw):]


def admit(config, end):
    owner = config["owner"]
    require(type(config["node"]) is str and config["node"] == os.path.realpath("/proc/%d/exe" % owner["pid"]),
            "consumer Node differs from the actual owner executable")
    mode, args = validate_consumer(config["consumer"])
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
    bootstrap = root + "/scripts/validation/perception-ci-child-bootstrap.mjs"
    for path, pin in ((config["node"], config["nodeSha256"]), (bootstrap, config["bootstrapSha256"])):
        require(type(path) is str and os.path.isabs(path) and os.path.realpath(path) == path
                and type(pin) is str and re.fullmatch(r"[a-f0-9]{64}", pin), "fixed bootstrap executable pin required")
        remaining(end)
        digest = hashlib.sha256()
        total = 0
        with open(path, "rb", buffering=0) as source:
            while True:
                remaining(end)
                block = source.read(65536)
                if not block:
                    break
                total += len(block)
                require(total <= 268435456, "bootstrap source byte bound")
                digest.update(block)
        require(digest.hexdigest() == pin, "external bootstrap source pin mismatch")
    before = process_identity(owner["pid"])
    require(key(before) == key(owner) and before["state"] not in TERMINAL, "self-admission owner no longer live")
    require(os.path.realpath("/proc/%d/exe" % owner["pid"]) == config["node"], "consumer Node differs from measured owner")
    normal = credentials(owner["pid"])
    require(normal["uids"] == [owner["uid"]] * 4 and normal["gids"] == [owner["gid"]] * 4
            and normal["NoNewPrivs"] == 0
            and all(int(normal[name], 16) == 0 for name in ("CapInh", "CapPrm", "CapEff", "CapAmb")), "owner is not normal CI authority")
    environment = config["environment"]
    validate_environment(environment)
    remaining(end)
    scope = root_scope(config, False)
    # No read(PID)->write(PID) race: this process cannot have its own PID reused
    # while it performs the write. Descendants inherit kernel membership.
    with open(scope["path"] + "/cgroup.procs", "w", encoding="ascii") as target:
        target.write(str(os.getpid()))
    require(membership(os.getpid()) == scope["membership"], "self-admission kernel membership mismatch")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
    libc.prctl.restype = ctypes.c_int
    require(libc.prctl(7, 0, 0, 0, 0) == 0, "consumer keepcaps must remain disabled")
    require(libc.prctl(47, 4, 0, 0, 0) == 0, "consumer ambient clear failed")
    last = int(read_bounded("/proc/sys/kernel/cap_last_cap").strip())
    require(0 <= last < 64, "unsupported capability bound")
    for capability in range(last + 1):
        if not (int(normal["CapBnd"], 16) & (1 << capability)):
            require(libc.prctl(24, capability, 0, 0, 0) == 0, "consumer bounding reduction failed")
    os.setgroups(normal["groups"])
    os.setresgid(owner["gid"], owner["gid"], owner["gid"])
    os.setresuid(owner["uid"], owner["uid"], owner["uid"])
    measured = credentials(os.getpid())
    require(measured == normal, "consumer credentials were not restored to the actual normal owner")
    remaining(end)
    emit({"abi": ABI, "runId": config["runId"], "stage": "admit-exec-intent", "scope": scope,
          "identity": process_identity(os.getpid()), "credentials": measured,
          "node": config["node"], "nodeSha256": config["nodeSha256"], "bootstrapSha256": config["bootstrapSha256"]}, end)
    os.chdir(root)
    arguments = ["cgroup-fixture", args[0]] if mode == "fixture" else ["cgroup-consumer", mode, *args]
    os.execve(config["node"], [config["node"], bootstrap, *arguments], environment)


def guardian(config, end):
    owner = config["owner"]
    require(os.getuid() == owner["uid"] and os.getgid() == owner["gid"] and os.getppid() == owner["pid"], "guardian must be the normal direct child")
    parent = process_identity(os.getppid())
    require(key(parent) == key(owner), "guardian parent identity mismatch")
    token = os.pidfd_open(owner["pid"], 0)
    try:
        require(key(process_identity(owner["pid"])) == key(owner), "guardian parent changed after pidfd open")
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
        libc.prctl.restype = ctypes.c_int
        require(libc.prctl(1, signal.SIGCONT, 0, 0, 0) == 0, "guardian parent-death setup failed")
        result = ctypes.c_int()
        # Pass a full-width pointer through prctl's unsigned-long argument.
        pointer = ctypes.cast(ctypes.byref(result), ctypes.c_void_p).value
        require(libc.prctl(2, pointer, 0, 0, 0) == 0 and result.value == signal.SIGCONT, "guardian parent-death readback failed")
        require(libc.prctl(38, 1, 0, 0, 0) == 0, "guardian NNP setup failed")
        require(os.getppid() == owner["pid"] and key(process_identity(owner["pid"])) == key(owner), "guardian parent changed during prctl")
        status = credentials(os.getpid())
        require(all(int(status[name], 16) == 0 for name in ("CapInh", "CapPrm", "CapEff", "CapAmb"))
                and status["NoNewPrivs"] == 1, "guardian effective authority is not zero")
        scope = config["scope"]
        metadata = os.fstat(3)
        require(metadata.st_dev == scope["kill"]["dev"] and metadata.st_ino == scope["kill"]["ino"], "guardian kill FD identity mismatch")
        require(os.readlink("/proc/self/fd/3") == scope["path"] + "/cgroup.kill", "guardian kill FD path mismatch")
        emit({"abi": ABI, "runId": config["runId"], "stage": "guardian-ready", "identity": process_identity(os.getpid()),
              "credentials": status, "parentDeathSignal": "SIGCONT", "scope": scope}, end)
        if config["controlledStop"]:
            os.kill(os.getpid(), signal.SIGSTOP)  # Fixed self-stop; never a signal RPC.
        reason = "deadline"
        while time.monotonic() < end:
            ready = select.select([token, 0], [], [], min(0.1, remaining(end)))[0]
            if token in ready:
                reason = "owner-terminal"; break
            if 0 in ready:
                raw = os.read(0, 2)
                if raw == b"F":
                    emit({"abi": ABI, "runId": config["runId"], "stage": "guardian-final", "containment": False}, end)
                    return
                require(not raw, "guardian closed control protocol")
                reason = "owner-eof"; break
        # A STOPped guardian is resumed by the kernel on owner death. Only the
        # already-authenticated kill FD is written; no PID signal RPC exists.
        os.write(3, b"1")
        if time.monotonic() < end:
            emit({"abi": ABI, "runId": config["runId"], "stage": "guardian-final", "containment": True, "reason": reason}, end)
    finally:
        os.close(token)
        os.close(3)


def main():
    require(sys.platform == "linux" and sys.argv[1:] in (["--create"], ["--remove"], ["--guardian"], ["--admit"]), "fixed cgroup entrypoints only")
    mode = sys.argv[1][2:]
    started = time.monotonic()
    config = validate_config(read_config(0, started + 5), mode)
    end = min(started + 5, time.monotonic() + (config["deadlineAt"] - time.time() * 1000) / 1000)
    if mode == "guardian":
        end = time.monotonic() + (config["deadlineAt"] - time.time() * 1000) / 1000
        guardian(config, end)
        return
    if mode == "admit":
        admit(config, end)
        return
    scope = root_scope(config, mode == "create")
    remaining(end)
    empty = assert_empty(scope)
    if mode == "remove":
        os.rmdir(scope["path"])
    emit({"abi": ABI, "runId": config["runId"], "stage": mode + "-final", "scope": scope,
          "empty": empty, "success": True, "helperIdentity": process_identity(os.getpid())}, end)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error).encode("utf8")
        print(json.dumps({"abi": ABI, "success": False, "name": type(error).__name__,
                          "messageSha256": hashlib.sha256(message).hexdigest(), "messageBytes": len(message)}), file=sys.stderr)
        sys.exit(1)
