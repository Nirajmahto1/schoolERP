# ──────────────────────────────────────────────
# School ERP — ai-service (Phase 7.2)
#
# Real-data AI surfaces: descriptive student/class reports and the at-risk
# restatement, all scoped by the gateway assertion and labelled as
# statistics, never as predictions. The random-choice placeholder this file
# once served is gone — AI on invented data dies in the first pilot.
# ──────────────────────────────────────────────

from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import db
from src.api.routes import router as api_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pool init happens lazily on first query; shutdown closes it cleanly.
    yield
    await db.close_pool()


app = FastAPI(
    title="School ERP - AI Services",
    description="Defensible AI surfaces over real tenant data (Phase 7.2)",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS is narrow on purpose: the admin console only. The browser never talks
# to this service directly in production — the gateway is the front door and
# carries the assertion.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3100", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1/ai")


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "ai-service", "timestamp": datetime.now().isoformat()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=5002, reload=False)
