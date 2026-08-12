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


settings = Settings()
