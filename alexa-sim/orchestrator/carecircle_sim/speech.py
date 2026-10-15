"""Speech out: Amazon Polly neural voice, or the browser's own TTS as a fallback."""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Any
from xml.sax.saxutils import escape

log = logging.getLogger("carecircle.speech")

BILINGUAL_HINDI = {"Kajal"}
SLOW_RATE = "85%"


@dataclass
class Speech:
    mode: str = "browser"  # "polly" or "browser"
    voice: str | None = None
    detail: str = "mock mode: browser speech"
    client: Any = None

    @classmethod
    def start(cls, region: str, voices: tuple[str, ...], enabled: bool) -> Speech:
        """Tries each voice once with a tiny synthesis; the first that works is used."""
        if not enabled:
            return cls()
        try:
            import boto3

            client = boto3.client("polly", region_name=region)
        except Exception as err:  # noqa: BLE001
            return cls(detail=f"Polly unavailable, using browser speech: {err}")
        errors = []
        for voice in voices:
            try:
                client.synthesize_speech(Text="Ready.", VoiceId=voice, Engine="neural", OutputFormat="mp3")
                log.info("Polly neural voice %s works in %s", voice, region)
                return cls(mode="polly", voice=voice, detail=f"Polly neural {voice} in {region}", client=client)
            except Exception as err:  # noqa: BLE001
                errors.append(f"{voice}: {err}")
                log.warning("Polly voice %s failed: %s", voice, err)
        return cls(detail="Polly failed, using browser speech. " + "; ".join(errors))

    def can_speak(self, language: str) -> bool:
        """Kajal speaks Indian English and Hindi; other voices only English."""
        return self.mode == "polly" and (language == "en" or self.voice in BILINGUAL_HINDI)

    def synthesize(self, text: str, language: str = "en", slow: bool = False) -> str | None:
        """Base64 MP3, or None to let the browser speak."""
        if not text or not self.can_speak(language):
            return None
        args: dict[str, Any] = {"VoiceId": self.voice, "Engine": "neural", "OutputFormat": "mp3"}
        if language == "hi":
            args["LanguageCode"] = "hi-IN"
        if slow:
            # Neural voices support <prosody rate>; slower speech is easier to follow for older listeners.
            args["TextType"] = "ssml"
            args["Text"] = f'<speak><prosody rate="{SLOW_RATE}">{escape(text[:2800])}</prosody></speak>'
        else:
            args["Text"] = text[:2900]
        resp = self.client.synthesize_speech(**args)
        return base64.b64encode(resp["AudioStream"].read()).decode("ascii")
