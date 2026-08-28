#!/usr/bin/env python3

from __future__ import annotations

import os
import re
from pathlib import Path

from dotenv import load_dotenv


# ============================================================
# TIKBOO WORKER — CONFIGURATION
# ============================================================

WORKER_VERSION = "stream-4.0.0"

SELECTION_ENGINE_VERSION = "V2"
SELECTION_ENGINE_CODENAME = "Control"


# ============================================================
# PATHS / ENVIRONMENT
# ============================================================

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"

load_dotenv(ENV_FILE)


# ============================================================
# R2
# ============================================================

R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY"]
R2_SECRET_KEY = os.environ["R2_SECRET_KEY"]
R2_BUCKET = os.environ["R2_BUCKET"]

R2_PRESIGNED_URL_SECONDS = int(
    os.getenv("R2_PRESIGNED_URL_SECONDS", "21600")
)


# ============================================================
# SUPABASE
# ============================================================

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]


# ============================================================
# CLOUDFLARE STREAM
# ============================================================

CLOUDFLARE_ACCOUNT_ID = os.environ["CLOUDFLARE_ACCOUNT_ID"]
CLOUDFLARE_STREAM_API_TOKEN = os.environ["CLOUDFLARE_STREAM_API_TOKEN"]

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"

STREAM_POLL_SECONDS = int(
    os.getenv("STREAM_POLL_SECONDS", "10")
)

STREAM_WAIT_SECONDS = int(
    os.getenv("STREAM_WAIT_SECONDS", "1200")
)

STREAM_MEDIA_FRESH_RETRIES = int(
    os.getenv("STREAM_MEDIA_FRESH_RETRIES", "1")
)


# ============================================================
# HTTP
# ============================================================

HTTP_TIMEOUT_SECONDS = int(
    os.getenv("HTTP_TIMEOUT_SECONDS", "60")
)


# ============================================================
# SOURCE DISCOVERY
# ============================================================

CREATORS_PREFIX = "creators/"

SOURCE_PATTERN = re.compile(
    r"^creators/([^/]+)/(\d+)\.mp4$",
    re.IGNORECASE,
)


# ============================================================
# STREAM IDENTIFIERS
# ============================================================

STREAM_UID_MARKER_PREFIX = "cfstream://"

STREAM_UID_FROM_URL_PATTERN = re.compile(
    r"(?:cloudflarestream\.com|videodelivery\.net)/([A-Za-z0-9_-]{10,64})/",
    re.IGNORECASE,
)


# ============================================================
# MEDIA FAILURE STATE
# ============================================================

MEDIA_TERMINAL_ERROR_PREFIX = "[stream-media-terminal]"

PROCESS_OUTCOME_COMPLETED = "completed"
PROCESS_OUTCOME_PROCESSING = "processing"
PROCESS_OUTCOME_MEDIA_FAILED = "media_failed"


# ============================================================
# SELECTION SYSTEM V2 — CONTROL
# ============================================================

SELECTION_HISTORY_LIMIT = int(
    os.getenv("SELECTION_HISTORY_LIMIT", "200")
)
