"""Test 2 analysis (asscrack 0.2.0, LAN test card 2, 2026-11-17).

Read-only. It reads the operator evidence and the 127.0.0.1 reproduction results in this folder.
It writes only TEST2_ANALYSIS.json in this folder.
There are no field logs: the operator did not save the terminal or the console output.
Time convention: in history-net.json, dt = 0 is the first peer-joined event of the restarted node (ms).
Run: python -I test2_analysis.py
"""
import hashlib
import json
import os
import sys
from pathlib import Path

if sys.platform == "win32":
    import ctypes
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)  # below normal
else:
    os.nice(10)

HERE = Path(__file__).resolve().parent
ORIGINAL = HERE.parent / "evidence" / "original" / "operator"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    inputs = {}
    for p in sorted(ORIGINAL.glob("*.txt")):
        inputs[f"evidence/original/operator/{p.name}"] = sha256(p)
    net_path = HERE / "history-net.json"
    app_paths = sorted(HERE.glob("history-app-*.json"))
    for p in [net_path, *app_paths]:
        inputs[f"analysis/{p.name}"] = sha256(p)

    net = json.loads(net_path.read_text(encoding="utf-8"))
    print("history-net.json result keys:", sorted(net["results"][0].keys()))
    runs = net["results"]
    history_dt = [r["historyEvent"]["dt"] for r in runs if r.get("historyEvent")]
    network = {
        "runs": len(runs),
        "pass": sum(1 for r in runs if r.get("pass")),
        "restarted_has_before_voice": sum(1 for r in runs if r.get("restartedHasBeforeVoice")),
        "restarted_elected_self": sum(1 for r in runs if r.get("restartedElectedSelf")),
        "history_after_host_known": sum(1 for r in runs if r.get("historyAfterHostKnown")),
        "restarted_id_lower": sum(1 for r in runs if r.get("restartedIdLower")),
        "history_dt_ms_min": min(history_dt) if history_dt else None,
        "history_dt_ms_max": max(history_dt) if history_dt else None,
        "failover_ms": [r.get("failoverMs") for r in runs],
        "by_case_and_delay": {},
    }
    for r in runs:
        key = f"case {r['case']}, restart delay {r['restartDelayMs']} ms"
        d = network["by_case_and_delay"].setdefault(key, {"runs": 0, "pass": 0})
        d["runs"] += 1
        d["pass"] += 1 if r.get("pass") else 0

    window = []
    for p in app_paths:
        r = json.loads(p.read_text(encoding="utf-8"))
        print(p.name, "keys:", sorted(r.keys()))
        window.append({
            "file": p.name,
            "build": ("fix 4752fd1 (opus/history-restart)" if p.stem.endswith("-fix")
                      else "fix 2a62b4d (opus/history-restart, with the log file)" if p.stem.endswith("-fix2")
                      else "0.2.0 .exe" if "exe020" in p.stem else "main 0ade5d9 (dev)"),
            "case": r.get("case"),
            "host": r.get("host"),
            "sender": r.get("sender"),
            "restarted_sees_peer": r.get("restartedSeesPeer"),
            "restarted_host_is_remaining": r.get("restartedHostIsRemaining"),
            "restarted_window_lines": len(r.get("restartedWindow") or []),
            "restarted_window_has_before_voice": r.get("restartedWindowHasBeforeVoice"),
            "remaining_window_lines": len(r.get("remainingWindow") or []),
            "console_error_lines": sum(1 for lines in (r.get("consoleLines") or {}).values() for l in lines
                                       if "error" in l.lower() or "exception" in l.lower()),
            "error": r.get("error"),
        })

    out = {
        "test": "LAN test card 2, asscrack 0.2.0, 2026-11-17",
        "field_logs": None,
        "field_logs_note": "The operator saved no terminal or console output. The field result is the operator report only.",
        "reproduction_scope": "127.0.0.1, one PC. Not a LAN result.",
        "time_convention": "history-net.json: dt = 0 is the first peer-joined event of the restarted node, in ms.",
        "inputs_sha256": inputs,
        "network_layer": network,
        "window": window,
    }
    (HERE / "TEST2_ANALYSIS.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({"network_pass": f"{network['pass']} of {network['runs']}",
                      "window": [(w["build"], w["case"], w["restarted_window_has_before_voice"]) for w in window]}, indent=1))


if __name__ == "__main__":
    main()
