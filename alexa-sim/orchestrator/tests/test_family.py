"""Family features end to end in mock mode: live updates between devices (resources/subscribe),
safety alert announcements, gentle reminders, "say that again", Hindi, and the evening summary."""

from __future__ import annotations

import json
import queue
import threading
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from .conftest import of, running_mcp_server, running_sim, speech, turn


@pytest.fixture(scope="module")
def fam() -> Iterator[str]:
    """Its own server: these tests log doses and change Rose's language."""
    with running_mcp_server() as mcp_url, running_sim(mcp_url) as url:
        yield url


class Device:
    """Listens to /events for one profile, like a browser tab with that device open."""

    def __init__(self, sim: str, profile: str) -> None:
        self.events: queue.Queue[tuple[str, dict[str, Any]]] = queue.Queue()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(sim, profile), daemon=True)
        self._thread.start()

    def _run(self, sim: str, profile: str) -> None:
        with httpx.Client(timeout=None) as client, client.stream("GET", f"{sim}/events", params={"profile": profile}) as resp:
            kind = None
            for line in resp.iter_lines():
                if self._stop.is_set():
                    return
                if line.startswith("event: "):
                    kind = line[7:]
                elif line.startswith("data: ") and kind:
                    self.events.put((kind, json.loads(line[6:])))
                    kind = None

    def wait_for(self, kind: str, check: Any = lambda d: True, timeout: float = 10) -> dict[str, Any]:
        seen = []
        while True:
            try:
                k, data = self.events.get(timeout=timeout)
            except queue.Empty:
                raise AssertionError(f"no {kind} event matched; saw {[s[0] for s in seen]}") from None
            seen.append((k, data))
            if k == kind and check(data):
                return data

    def close(self) -> None:
        self._stop.set()


def status_of(today: dict[str, Any], med: str, slot: str) -> str:
    return next(d["status"] for d in today["status"]["doses"] if d["medicationId"] == med and d["slot"] == slot)


def test_a_dose_rose_logs_shows_up_on_sams_device(fam: str) -> None:
    sam = Device(fam, "sam")
    try:
        first = sam.wait_for("today")
        assert status_of(first, "med-vitd", "morning") == "due"
        turn(fam, "rose", "I took my vitamin D")
        live = sam.wait_for("today", lambda d: status_of(d, "med-vitd", "morning") == "taken")
        assert live["viewer"]["id"] == "sam"
        # The orchestrator subscribed over MCP and re-read the resource when told it changed.
        log = httpx.get(f"{fam}/rpc", params={"profile": "sam"}).json()["entries"]
        assert any(e["method"] == "resources/subscribe" and e["body"]["params"]["uri"].endswith("/today") for e in log)
        assert any(e["method"] == "notifications/resources/updated" for e in log)
    finally:
        sam.close()


def test_a_fall_is_announced_on_the_family_devices_not_roses(fam: str) -> None:
    sam, rose = Device(fam, "sam"), Device(fam, "rose")
    try:
        sam.wait_for("today")
        rose.wait_for("today")
        turn(fam, "rose", "I had a fall in the kitchen")
        alert = sam.wait_for("announcement", lambda d: d["kind"] == "alert")
        assert alert["text"].startswith("CareCircle alert: at 9 am, Rose said: I had a fall in the kitchen.")
        assert alert["text"].endswith("Please check on her.")
        with pytest.raises(AssertionError):
            rose.wait_for("announcement", lambda d: d["kind"] == "alert", timeout=1.5)
    finally:
        sam.close()
        rose.close()


def test_a_reminder_then_yes_logs_the_doses(fam: str) -> None:
    r = httpx.post(f"{fam}/profiles/rose/remind", timeout=30).json()
    assert r["reminded"] is True
    assert r["text"].startswith("Rose, a gentle reminder: your Metformin")
    events = turn(fam, "rose", "Yes, I have")
    call = of(events, "tool_call")[0]
    assert call["name"] == "log_medication"
    assert call["arguments"] == {"medication_ids": ["med-metformin"]}  # Vitamin D was logged in the first test
    assert speech(events).startswith("Got it. I've logged Metformin for the morning.")


def test_say_that_again_repeats_slowly_without_a_tool(fam: str) -> None:
    said = speech(turn(fam, "maya", "What does Mom take tonight?"))
    events = turn(fam, "maya", "Sorry, say that again?")
    assert of(events, "tool_call") == []
    again = of(events, "speech")[0]
    assert again["text"] == said
    assert again["slow"] is True and again["repeat"] is True


def test_rose_can_switch_to_hindi(fam: str) -> None:
    r = httpx.post(f"{fam}/profiles/rose/language", json={"language": "hi"}, timeout=30).json()
    assert r["text"] == "ठीक है Rose जी, अब मैं आपसे हिंदी में बात करूँगी।"
    try:
        events = turn(fam, "rose", "सुप्रभात")
        assert of(events, "tool_call")[0]["name"] == "get_care_status"
        hello = of(events, "speech")[0]
        assert hello["text"].startswith("सुप्रभात, Rose जी।")
        assert hello["lang"] == "hi"

        events = turn(fam, "rose", "मुझे चक्कर आ रहा है")
        assert of(events, "tool_call")[0]["arguments"] == {"note": 'Feeling dizzy (in Hindi: "मुझे चक्कर आ रहा है")'}
        assert speech(events).startswith("धन्यवाद")

        # Sam still hears English.
        assert speech(turn(fam, "sam", "How is Mom today?")).startswith("Rose has taken")
    finally:
        httpx.post(f"{fam}/profiles/rose/language", json={"language": "en"}, timeout=30)


def test_the_evening_summary_reaches_mayas_phone(fam: str) -> None:
    maya = Device(fam, "maya")
    try:
        assert maya.wait_for("inbox")["messages"] == []
        r = httpx.post(f"{fam}/profiles/sam/summary", timeout=30).json()
        assert r["text"] == "Done. I've sent today's summary to Sam and Maya in the CareCircle app."
        inbox = maya.wait_for("inbox", lambda d: len(d["messages"]) == 1)
        assert inbox["messages"][0]["title"] == "Rose's day: Saturday 10 October"
        assert 'Alert, 9 am: "I had a fall in the kitchen" (a fall).' in inbox["messages"][0]["text"]
    finally:
        maya.close()
