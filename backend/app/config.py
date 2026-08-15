from pydantic_settings import BaseSettings, SettingsConfigDict


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
    cors_origins: list[str] = ["http://localhost:5173"]
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


settings = Settings()
