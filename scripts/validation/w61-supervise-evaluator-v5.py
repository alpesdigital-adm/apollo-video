"""Run one W61 V5 audit/evaluation process with a hard owner deadline.

The ledger and log must be private paths outside the repository. This wrapper
never infers; it supervises the evaluator process and records its terminal PID.
"""

import argparse
import datetime
import hashlib
import json
import os
import signal
import subprocess
import sys
from pathlib import Path


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deadline-seconds", type=int, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if (not 1 <= args.deadline_seconds <= 240 or not command or
        args.ledger.exists() or args.log.exists() or args.ledger == args.log or
        not args.ledger.is_absolute() or not args.log.is_absolute()):
        raise SystemExit("SUPERVISOR_ARGUMENTS_INVALID")
    ledger = {"protocol": "w61-v5-process-supervisor", "ownerPid": os.getpid(),
              "command": command, "deadlineSeconds": args.deadline_seconds,
              "startedUtc": utc(), "timedOut": False, "childPid": None,
              "childExitCode": None, "childTerminal": False}
    args.ledger.parent.mkdir(parents=True, exist_ok=True)
    args.log.parent.mkdir(parents=True, exist_ok=True)
    child = None
    with args.log.open("xb") as output:
        try:
            flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                     stderr=subprocess.STDOUT, creationflags=flags,
                                     start_new_session=os.name != "nt")
            ledger["childPid"] = child.pid
            try:
                ledger["childExitCode"] = child.wait(timeout=args.deadline_seconds)
            except subprocess.TimeoutExpired:
                ledger["timedOut"] = True
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                                   stdout=output, stderr=subprocess.STDOUT, timeout=15, check=False)
                else:
                    os.killpg(child.pid, signal.SIGKILL)
                ledger["childExitCode"] = child.wait(timeout=15)
        except Exception as error:
            ledger["supervisorError"] = f"{type(error).__name__}:{str(error)[:120]}"
            if child and child.poll() is None:
                child.kill()
                ledger["childExitCode"] = child.wait(timeout=15)
        finally:
            ledger["childTerminal"] = child is not None and child.poll() is not None
            ledger["finishedUtc"] = utc()
    ledger["logSha256"] = sha(args.log)
    args.ledger.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ledger": str(args.ledger), "ledgerSha256": sha(args.ledger),
                      "childPid": ledger["childPid"], "childExitCode": ledger["childExitCode"],
                      "childTerminal": ledger["childTerminal"], "timedOut": ledger["timedOut"]}))
    if ledger.get("supervisorError") or ledger["timedOut"] or not ledger["childTerminal"] or ledger["childExitCode"] != 0:
        raise SystemExit("SUPERVISED_RUN_FAILED")


if __name__ == "__main__":
    main()
