"""Regenerate the README screenshots in docs/screenshots/.

Boots the standalone API server with HOME pointed at a throwaway folder, seeds it with
obviously fake fixture data over the HTTP API, serves the renderer with Vite and
captures key screens at 1440x900 with Playwright (Chromium). TaskPilot keeps its data
in ~/.taskpilot, so overriding HOME keeps your real database out of it.

    pip install playwright && python -m playwright install chromium
    npm install
    python scripts/screenshots/capture.py

Ports 7847 (API) and 5173 (Vite) must be free.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "screenshots"
API = "http://127.0.0.1:7847"
UI = "http://localhost:5173"
BIN = ROOT / "node_modules" / ".bin"
EXE = ".cmd" if os.name == "nt" else ""

# Fixture data. Every name is a placeholder so nobody mistakes it for real work.
TASKS = [
    {"title": "Draft the Example Co onboarding email", "priority": "p1", "agent_method": "cowork", "agent_executable": True, "tags": ["demo", "writing"], "due_days": 1},
    {"title": "Review sample pricing page copy", "priority": "p2", "agent_method": "either", "agent_executable": True, "tags": ["demo", "review"], "due_days": 3},
    {"title": "Fix flaky test in demo-app checkout", "priority": "p1", "agent_method": "cli", "agent_executable": True, "tags": ["demo", "code"], "due_days": 2},
    {"title": "Renew the placeholder domain", "priority": "p0", "agent_method": "human_only", "agent_executable": False, "tags": ["demo", "admin"], "due_days": 0},
    {"title": "Summarize notes from the Acme Corp test call", "priority": "p2", "agent_method": "cowork", "agent_executable": True, "tags": ["demo", "notes"]},
    {"title": "Sort the demo screenshots folder", "priority": "p3", "agent_method": "either", "agent_executable": True, "tags": ["demo", "cleanup"]},
    {"title": "Outline a sample blog post on local-first apps", "priority": "p2", "agent_method": "cowork", "agent_executable": True, "tags": ["demo", "writing"], "due_days": 5},
    {"title": "Book the Example Co quarterly review", "priority": "p2", "agent_method": "human_only", "agent_executable": False, "tags": ["demo", "calendar"], "due_days": 7},
]

# (title, owner_type, owner_name, client, status, sla_hours, hours_since_start)
DELIVERY = [
    ("Collect roster for Sample Clinic A", "offshore", "Demo Offshore 1", "Sample Clinic A", "in_progress", 72, 80),
    ("Run source match for Example Practice", "contractor", "Demo Contractor", "Example Practice", "queued", 24, 20),
    ("Review exceptions for Test Health Group", "jack", None, "Test Health Group", "in_progress", 48, 10),
    ("Send obligation calendar to Sample Clinic B", "jack", None, "Sample Clinic B", "waiting_on_client", 48, 30),
    ("Verify licenses for Demo Medical LLC", "contractor", "Demo Contractor", "Demo Medical LLC", "blocked", 96, 60),
    ("Prepare intake packet for Placeholder Partners", "offshore", None, "Placeholder Partners", "queued", 120, 4),
]


def call(method: str, path: str, body: object | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"{}")


def wait_for(url: str, seconds: int = 90) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"{url} did not come up")


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def seed() -> None:
    now = datetime.now(timezone.utc)
    if call("GET", "/api/tasks")["tasks"]:
        raise RuntimeError("the API on :7847 already has tasks; refusing to seed a database that is not the throwaway one")
    call("POST", "/api/onboarding/complete")
    call("PATCH", "/api/settings/theme", {"value": "light"})
    for t in TASKS:
        body = {k: v for k, v in t.items() if k != "due_days"}
        if "due_days" in t:
            body["due"] = (now + timedelta(days=t["due_days"])).date().isoformat()
        call("POST", "/api/tasks", body)
    for title, owner_type, owner_name, client, status, sla, since in DELIVERY:
        call("POST", "/api/delivery/items", {
            "title": title,
            "owner_type": owner_type,
            "owner_name": owner_name,
            "client": client,
            "venture": "Demo Venture",
            "status": status,
            "sla_hours": sla,
            "sla_started_at": iso(now - timedelta(hours=since)),
        })


def capture() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, color_scheme="light")

        def shot(route: str, name: str, ready: str, before=None) -> None:
            page.goto(f"{UI}/#{route}")
            page.wait_for_selector(ready, timeout=30_000)
            if before:
                before()
            page.wait_for_load_state("networkidle")
            page.wait_for_timeout(600)
            page.screenshot(path=str(OUT / name))
            print(f"wrote docs/screenshots/{name}")

        shot("/inbox", "inbox.png", "text=Draft the Example Co onboarding email")
        shot("/board", "board.png", "text=Fix flaky test in demo-app checkout")
        shot("/delivery", "delivery-queue.png", "text=Collect roster for Sample Clinic A")

        def open_template() -> None:
            page.get_by_role("button", name="templates", exact=True).click()
            page.wait_for_selector("text=Collect the practice roster and identifiers", timeout=15_000)

        shot("/delivery", "delivery-template.png", "text=Collect roster for Sample Clinic A", open_template)
        shot("/settings", "settings.png", "h1, h2")
        browser.close()


def main() -> int:
    home = Path(tempfile.mkdtemp(prefix="taskpilot-shots-"))
    env = {
        **os.environ,
        # The data folder is os.homedir()/.taskpilot; TASKPILOT_HOME is not read.
        "HOME": str(home),
        "USERPROFILE": str(home),
        "TASKPILOT_DISABLE_AUTH": "1",
        "TASKPILOT_DISABLE_SCHEDULES": "1",
        "TASKPILOT_DISABLE_BOOT_TASKS": "1",
        "TASKPILOT_DISABLE_STATUS_REPORT": "1",
        "TASKPILOT_DISABLE_TELEMETRY": "1",
        "TASKPILOT_DISABLE_BACKUPS": "1",
        "TASKPILOT_DISABLE_AUDIT_RETENTION": "1",
    }
    kw = {"cwd": ROOT, "env": env, "stdout": subprocess.DEVNULL, "stderr": subprocess.STDOUT, "start_new_session": os.name != "nt"}
    procs = [
        subprocess.Popen([str(BIN / f"tsx{EXE}"), "src/main/server/standalone.ts"], **kw),
        subprocess.Popen([str(BIN / f"vite{EXE}"), "--port", "5173", "--strictPort"], **kw),
    ]
    try:
        for proc in procs:
            time.sleep(1)
            if proc.poll() is not None:
                raise RuntimeError("server exited early; are ports 7847 and 5173 free?")
        wait_for(API + "/api/health")
        wait_for(UI)
        seed()
        capture()
    finally:
        for proc in procs:
            try:
                if os.name == "nt":
                    proc.terminate()
                else:
                    os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for proc in procs:
            proc.wait(timeout=15)
        shutil.rmtree(home, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
