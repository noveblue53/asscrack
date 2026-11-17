"""Test 4 analysis (asscrack 0.3.1, LAN test card 4, 2 computers, 2026-11-17).

Read-only. It reads the log files in ../evidence/original/this-pc and ../evidence/original/other-pc.
It writes only TEST4_ANALYSIS.json in this folder.
Labels: A = this PC (the computer of the operator), B = the other PC.
Time convention: each time is the ISO time of the computer that wrote the line. The clocks of A and B are not
synchronized. A time difference is measured only inside one log file, unless the text says "across computers".
Windows user names in paths are masked. Run: python -I test4_analysis.py
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

if sys.platform == "win32":
    import ctypes
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)  # below normal
else:
    os.nice(10)

HERE = Path(__file__).resolve().parent
ORIG = HERE.parent / "evidence" / "original"
LINE = re.compile(r"^(\S+Z) (\S+) (.*)$")
USER = re.compile(r"(?i)(users[\\/]+)[^\\/\"]+")


def t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def ms(a, b):
    return round((t(b) - t(a)).total_seconds() * 1000)


def parse(path):
    rows = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        m = LINE.match(raw)
        if not m:
            rows.append({"time": None, "level": "CONT", "text": USER.sub(r"\1<user>", raw)})
            continue
        rows.append({"time": m.group(1), "level": m.group(2), "text": USER.sub(r"\1<user>", m.group(3))})
    return rows


def main():
    files = {"A": sorted((ORIG / "this-pc").glob("*.log")), "B": sorted((ORIG / "other-pc").glob("*.log"))}
    out = {"time_convention": __doc__.split("Time convention: ")[1].split("\n")[0], "logs": [], "inputs_sha256": {}}
    events = []
    for comp, paths in files.items():
        for p in paths:
            out["inputs_sha256"][f"{p.parent.name}/{p.name}"] = hashlib.sha256(p.read_bytes()).hexdigest()
            rows = parse(p)
            print(p.name, "levels:", sorted({r["level"] for r in rows}))
            head = rows[0]["text"]
            log_path = re.search(r" log (.*)$", head)
            folder = None
            if log_path:
                parts = re.split(r"[\\/]", log_path.group(1))
                folder = "\\".join(parts[-3:-1])  # <app folder>\logs
            session = {
                "computer": comp, "file": p.name, "start": rows[0]["time"],
                "version": re.search(r"ASSCRACK (\S+)", head).group(1),
                "unpack_folder": (re.search(r"([A-Za-z0-9]+)[\\/]+ASSCRACK\.exe", head) or [None, None])[1],
                "log_app_folder": folder,
                "levels": {lvl: sum(1 for r in rows if r["level"] == lvl) for lvl in sorted({r["level"] for r in rows})},
                "window_levels": sorted({r["text"].split(" ", 1)[0] for r in rows if r["level"] == "WINDOW"}),
                "warn_or_error_lines": [r["text"] for r in rows if r["level"] in ("WARN", "ERROR")]
                + [r["text"] for r in rows if r["level"] == "WINDOW" and r["text"].split(" ", 1)[0] in ("warning", "error")],
            }
            joined = next((r for r in rows if r["text"].startswith("event peer-joined")), None)
            host = next((r for r in rows if r["text"].startswith("event host-changed")), None)
            applied = next((r for r in rows if r["text"].startswith("History applied")), None)
            shown = next((r for r in rows if r["level"] == "WINDOW" and " History shown" in r["text"]), None)
            sent = [r for r in rows if r["text"].startswith("History sent")]
            session["first_session_ms_after_start"] = ms(rows[0]["time"], joined["time"]) if joined else None
            session["host_changed_ms_after_session"] = ms(joined["time"], host["time"]) if joined and host else None
            session["history_applied"] = applied["text"] if applied else None
            session["history_applied_ms_after_session"] = ms(joined["time"], applied["time"]) if joined and applied else None
            session["history_shown"] = shown["text"].split(" (")[0].split(" ", 1)[1] if shown else None
            session["history_shown_ms_after_session"] = ms(joined["time"], shown["time"]) if joined and shown else None
            session["history_sent"] = [{"time": r["time"], "text": re.sub(r"12D3\w+", "<peer>", r["text"])} for r in sent]
            out["logs"].append(session)
            for r in rows:
                m = re.match(r"event (file-\w+) peer (\S+) offer (\S+)", r["text"])
                if m:
                    events.append({"computer": comp, "time": r["time"], "event": m.group(1), "peer": m.group(2)[-6:], "offer": m.group(3)[:8]})
                m = re.match(r"event (peer-left|host-changed|voice-state) peer (\S+)", r["text"])
                if m:
                    events.append({"computer": comp, "time": r["time"], "event": m.group(1), "peer": m.group(2)[-6:], "offer": None})

    offers = {}
    for e in events:
        if e["offer"]:
            offers.setdefault(e["offer"], []).append(e)
    transfers = []
    for oid, evs in offers.items():
        evs.sort(key=lambda e: e["time"])
        offer_ev = next((e for e in evs if e["event"] == "file-offer"), None)
        receiver = offer_ev["computer"] if offer_ev else None
        row = {"offer": oid, "receiver": receiver, "events": [f"{e['computer']} {e['event']} {e['time'][11:23]}" for e in evs]}
        if offer_ev:
            end = next((e for e in evs if e["computer"] == receiver and e["event"] in ("file-done", "file-cancelled", "file-failed")), None)
            row["receiver_offer_to_end_ms"] = ms(offer_ev["time"], end["time"]) if end else None
            row["receiver_end"] = end["event"] if end else None
            sender = "B" if receiver == "A" else "A"
            row["sender_end_events"] = [e["event"] for e in evs if e["computer"] == sender]
        transfers.append(row)
    out["transfers"] = transfers

    # Clock offset across computers: B "History sent" to the restarted A, and A "peer-joined" of that session.
    a2 = next(l for l in out["logs"] if l["computer"] == "A" and l["history_applied"])
    b_sent = next(s for l in out["logs"] if l["computer"] == "B" for s in l["history_sent"])
    a_rows = parse(ORIG / "this-pc" / a2["file"])
    a_join = next(r for r in a_rows if r["text"].startswith("event peer-joined"))
    out["clock_offset_estimate_ms_A_minus_B"] = ms(b_sent["time"], a_join["time"])
    out["unsent_note"] = "The log lines of file events have no direction and no 'by' field."
    (HERE / "TEST4_ANALYSIS.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ("clock_offset_estimate_ms_A_minus_B", "transfers")}, indent=1))
    for l in out["logs"]:
        print(l["computer"], l["file"], l["version"], l["unpack_folder"], l["log_app_folder"], "window", l["window_levels"],
              "warn/error", len(l["warn_or_error_lines"]), "applied", l["history_applied_ms_after_session"],
              "shown", l["history_shown_ms_after_session"], "host", l["host_changed_ms_after_session"])


if __name__ == "__main__":
    main()
