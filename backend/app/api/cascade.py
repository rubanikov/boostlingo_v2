from fastapi import APIRouter, WebSocket

from app.orchestrator import run_cascade_session

router = APIRouter(prefix="/ws", tags=["cascade"])


@router.websocket("/cascade")
async def cascade_websocket(websocket: WebSocket) -> None:
    """One full-duplex WebSocket per Cascade session: binary PCM16 mic
    audio in, JSON transcript/audio-meta messages plus binary TTS audio
    out. See `app.orchestrator.run_cascade_session` for the STT ->
    Translation -> TTS pipeline wiring."""
    await run_cascade_session(websocket)
