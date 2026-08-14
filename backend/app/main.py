from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.cascade import router as cascade_router
from app.api.observability import router as observability_router
from app.api.realtime import router as realtime_router
from app.api.telemetry import router as telemetry_router
from app.config import settings
from app.observability.otel import init_telemetry, shutdown_telemetry


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    init_telemetry()
    try:
        yield
    finally:
        shutdown_telemetry()


app = FastAPI(title="AI Interpreter Workbench", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(realtime_router)
app.include_router(cascade_router)
app.include_router(observability_router)
app.include_router(telemetry_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
