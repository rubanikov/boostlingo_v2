from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    deepgram_api_key: str = ""
    elevenlabs_api_key: str = ""
    # Premade ElevenLabs voice ("Rachel"), used for diarized speaker 0 (and
    # as the fallback for no/unrecognized speaker) in Cascade mode. See
    # `orchestrator._voice_for_speaker` for the speaker -> voice mapping.
    # Overridable via .env for anyone using a different voice.
    elevenlabs_voice_id: str = "21m00Tcm4TlvDq8ikWAM"
    # Second premade ElevenLabs voice ("Antoni"), used for diarized speaker
    # 1 so the two tested speakers are audibly distinct. Overridable via
    # .env.
    elevenlabs_voice_id_speaker_b: str = "ErXwobaYiN019PkySvjV"
    # Any further ElevenLabs voice ids this account can speak with, offered by
    # the tuning panel's TTS voice pickers alongside the two above. There is
    # no hard-coded list of premade voices: a voice id the server cannot
    # actually use has no business in the picker.
    #
    # Parsed as a **comma-separated** list (`a,b,c`), not JSON. `NoDecode`
    # turns off pydantic-settings' default JSON decoding for complex types,
    # which would otherwise reject `a,b` with a SettingsError before any
    # validator ran. `cors_origins` below deliberately keeps the JSON form it
    # has always had.
    elevenlabs_voice_ids_extra: Annotated[list[str], NoDecode] = []
    # The WebSocket `Origin` guard (`orchestrator._cascade_ws`) checks this
    # same list, so widening it widens that guard. 5183 is the Playwright
    # harness's dev port (`frontend/playwright.config.ts`), a repo-owned
    # origin: without it, every e2e Cascade run is rejected at connect.
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:5183"]
    # Realtime-mode server-VAD tuning. Both default to "unset" so the session
    # is created at OpenAI's own defaults (~500ms silence ends a turn; resumed
    # speech interrupts the reply in flight), which is what COMPARISON.md's
    # as-shipped Realtime quality number was measured against. Set via .env
    # to run the tuned variant that write-up compares against: a longer
    # silence window so a mid-sentence breath doesn't end the turn, and no
    # barge-in so a resumed speaker doesn't cancel the translation being
    # spoken. See `app.api.realtime._turn_detection`.
    realtime_vad_silence_ms: int | None = None
    realtime_vad_interrupt_response: bool | None = None

    @field_validator("elevenlabs_voice_ids_extra", mode="before")
    @classmethod
    def _split_comma_separated(cls, value: object) -> object:
        """`ELEVENLABS_VOICE_IDS_EXTRA=id1,id2` -> `["id1", "id2"]`. Blank
        entries and surrounding whitespace are dropped so a trailing comma or
        an empty variable is not an error."""
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value


settings = Settings()
