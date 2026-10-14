"""Speech out: Amazon Polly neural voice, or the browser's own TTS as a fallback."""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("carecircle.speech")


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

    def synthesize(self, text: str) -> str | None:
        """Base64 MP3, or None to let the browser speak."""
        if self.mode != "polly" or not text:
            return None
        resp = self.client.synthesize_speech(Text=text[:2900], VoiceId=self.voice, Engine="neural", OutputFormat="mp3")
        return base64.b64encode(resp["AudioStream"].read()).decode("ascii")
