from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.cascade import router as cascade_router
from app.api.realtime import router as realtime_router
from app.api.tuning import router as tuning_router
from app.config import settings

app = FastAPI(title="AI Interpreter Workbench")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(realtime_router)
app.include_router(cascade_router)
app.include_router(tuning_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
