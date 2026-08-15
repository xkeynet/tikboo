#!/opt/tikboo-worker/venv/bin/python

from __future__ import annotations

import logging
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import boto3
import requests
from botocore.client import Config
from dotenv import load_dotenv


# ============================================================
# TIKBOO VIDEO WORKER
# ============================================================
#
# TARGET ARCHITECTURE
#
# Cloudflare R2:
#   SOURCE STORAGE ONLY
#
# Hetzner:
#   DISCOVERY / SELECTION / ORCHESTRATION
#
# Cloudflare Stream:
#   VIDEO INGEST / PROCESSING / TRANSCODING / PLAYBACK
#
# Supabase:
#   DATABASE / PROCESSING STATE / PLAYBACK METADATA
#
# IMPORTANT:
#
# This worker DOES NOT:
#   - run FFmpeg
#   - create HLS manifests
#   - create .ts segments
#   - create .m4s segments
#   - create init.mp4
#   - create poster.webp
#   - upload playback output back into R2
#
# Source MP4 files remain untouched in R2.
#
# ============================================================


WORKER_VERSION = "stream-v1"

SOURCE_PREFIX = "creators/"
SOURCE_PATTERN = re.compile(
    r"^creators/(?P<creator_handle>[^/]+)/(?P<video_number>\d+)\.mp4$",
    re.IGNORECASE,
)

STREAM_UID_MARKER_PREFIX = "cfstream://"

DEFAULT_STREAM_POLL_SECONDS = 10
DEFAULT_STREAM_WAIT_SECONDS = 20 * 60
DEFAULT_R2_PRESIGNED_URL_SECONDS = 6 * 60 * 60

HTTP_CONNECT_TIMEOUT = 15
HTTP_READ_TIMEOUT = 60

SUPABASE_PAGE_SIZE = 1000

LOG_FORMAT = "%(asctime)s | %(levelname)s | %(message)s"


# ============================================================
# LOGGING
# ============================================================


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format=LOG_FORMAT,
)

logger = logging.getLogger("tikboo-worker")


# ============================================================
# ENVIRONMENT
# ============================================================


def load_environment() -> None:
    """
    Support both possible production layouts:

        /opt/tikboo-worker/main.py
        /opt/tikboo-worker/worker/main.py

    Secrets are never printed.
    """

    current_file = Path(__file__).resolve()
    current_dir = current_file.parent

    env_candidates = [
        current_dir / ".env",
        current_dir.parent / ".env",
        Path("/opt/tikboo-worker/.env"),
    ]

    loaded: Set[Path] = set()

    for env_path in env_candidates:
        env_path = env_path.resolve()

        if env_path in loaded:
            continue

        loaded.add(env_path)

        if env_path.is_file():
            load_dotenv(env_path, override=False)


load_environment()


def first_env(*names: str) -> Optional[str]:
    for name in names:
        value = os.getenv(name)

        if value is not None:
            value = value.strip()

            if value:
                return value

    return None


def require_env(*names: str) -> str:
    value = first_env(*names)

    if value:
        return value

    joined = " / ".join(names)

    raise RuntimeError(
        f"Missing required environment variable: {joined}"
    )


R2_ENDPOINT_URL = require_env(
    "R2_ENDPOINT_URL",
    "CLOUDFLARE_R2_ENDPOINT_URL",
    "CLOUDFLARE_R2_ENDPOINT",
)

R2_ACCESS_KEY_ID = require_env(
    "R2_ACCESS_KEY_ID",
    "AWS_ACCESS_KEY_ID",
)

R2_SECRET_ACCESS_KEY = require_env(
    "R2_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
)

R2_BUCKET_NAME = require_env(
    "R2_BUCKET_NAME",
    "R2_BUCKET",
)

SUPABASE_URL = require_env(
    "SUPABASE_URL",
).rstrip("/")

SUPABASE_SERVICE_ROLE_KEY = require_env(
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_KEY",
    "SUPABASE_KEY",
)

CLOUDFLARE_ACCOUNT_ID = require_env(
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_ACCOUNT_ID",
)

CLOUDFLARE_STREAM_API_TOKEN = require_env(
    "CLOUDFLARE_STREAM_API_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CF_API_TOKEN",
)

STREAM_POLL_SECONDS = int(
    first_env("STREAM_POLL_SECONDS")
    or DEFAULT_STREAM_POLL_SECONDS
)

STREAM_WAIT_SECONDS = int(
    first_env("STREAM_WAIT_SECONDS")
    or DEFAULT_STREAM_WAIT_SECONDS
)

R2_PRESIGNED_URL_SECONDS = int(
    first_env("R2_PRESIGNED_URL_SECONDS")
    or DEFAULT_R2_PRESIGNED_URL_SECONDS
)


# ============================================================
# HTTP SESSION
# ============================================================


http = requests.Session()

http.headers.update(
    {
        "User-Agent": f"TikbooWorker/{WORKER_VERSION}",
    }
)


# ============================================================
# R2 CLIENT
# ============================================================


r2 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT_URL,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name="auto",
    config=Config(
        signature_version="s3v4",
        retries={
            "max_attempts": 5,
            "mode": "standard",
        },
    ),
)


# ============================================================
# DATA TYPES
# ============================================================


@dataclass(frozen=True)
class SourceVideo:
    creator_handle: str
    video_number: int
    source_mp4: str
    file_size_bytes: int


class CloudflareStreamError(RuntimeError):
    pass


class CloudflareStreamProcessingError(CloudflareStreamError):
    pass


# ============================================================
# GENERIC HELPERS
# ============================================================


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def safe_int(
    value: Any,
    default: int = 0,
) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def safe_float(
    value: Any,
    default: Optional[float] = None,
) -> Optional[float]:
    try:
        if value is None:
            return default

        return float(value)
    except (TypeError, ValueError):
        return default


def truncate_error(
    value: Any,
    limit: int = 4000,
) -> str:
    text = str(value)

    if len(text) <= limit:
        return text

    return text[:limit]


# ============================================================
# SUPABASE REST
# ============================================================


def supabase_headers(
    prefer: Optional[str] = None,
) -> Dict[str, str]:

    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    if prefer:
        headers["Prefer"] = prefer

    return headers


def supabase_request(
    method: str,
    table: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json_body: Optional[Any] = None,
    prefer: Optional[str] = None,
) -> requests.Response:

    url = f"{SUPABASE_URL}/rest/v1/{table}"

    response = http.request(
        method=method,
        url=url,
        headers=supabase_headers(prefer),
        params=params,
        json=json_body,
        timeout=(HTTP_CONNECT_TIMEOUT, HTTP_READ_TIMEOUT),
    )

    if not response.ok:
        raise RuntimeError(
            f"Supabase {method} {table} failed: "
            f"HTTP {response.status_code}: {response.text}"
        )

    return response


def supabase_get(
    table: str,
    params: Dict[str, Any],
) -> List[Dict[str, Any]]:

    response = supabase_request(
        "GET",
        table,
        params=params,
    )

    payload = response.json()

    if not isinstance(payload, list):
        raise RuntimeError(
            f"Unexpected Supabase response for {table}: "
            f"{type(payload).__name__}"
        )

    return payload


def supabase_get_all(
    table: str,
    *,
    select: str,
    filters: Optional[Dict[str, Any]] = None,
    page_size: int = SUPABASE_PAGE_SIZE,
) -> List[Dict[str, Any]]:

    rows: List[Dict[str, Any]] = []
    offset = 0

    while True:
        params: Dict[str, Any] = {
            "select": select,
            "limit": page_size,
            "offset": offset,
        }

        if filters:
            params.update(filters)

        page = supabase_get(
            table,
            params,
        )

        rows.extend(page)

        if len(page) < page_size:
            break

        offset += page_size

    return rows


def supabase_insert(
    table: str,
    payload: Dict[str, Any],
) -> Dict[str, Any]:

    response = supabase_request(
        "POST",
        table,
        json_body=payload,
        prefer="return=representation",
    )

    rows = response.json()

    if not isinstance(rows, list) or not rows:
        raise RuntimeError(
            f"Supabase insert into {table} returned no row"
        )

    return rows[0]


def supabase_patch(
    table: str,
    filters: Dict[str, Any],
    payload: Dict[str, Any],
) -> None:

    supabase_request(
        "PATCH",
        table,
        params=filters,
        json_body=payload,
        prefer="return=minimal",
    )


# ============================================================
# SUPABASE VIDEO STATE
# ============================================================


def get_video_by_source(
    source_mp4: str,
) -> Optional[Dict[str, Any]]:

    rows = supabase_get(
        "videos",
        {
            "select": "*",
            "source_mp4": f"eq.{source_mp4}",
            "limit": 1,
        },
    )

    return rows[0] if rows else None


def video_exists_in_supabase(
    source_mp4: str,
) -> bool:

    return get_video_by_source(source_mp4) is not None


def get_known_source_mp4s() -> Set[str]:
    rows = supabase_get_all(
        "videos",
        select="source_mp4",
    )

    result: Set[str] = set()

    for row in rows:
        source_mp4 = row.get("source_mp4")

        if isinstance(source_mp4, str) and source_mp4:
            result.add(source_mp4)

    return result


def creator_exists(
    creator_handle: str,
) -> bool:

    rows = supabase_get(
        "creators",
        {
            "select": "handle",
            "handle": f"eq.{creator_handle}",
            "limit": 1,
        },
    )

    return bool(rows)


def get_creator_handles() -> Set[str]:
    rows = supabase_get_all(
        "creators",
        select="handle",
    )

    result: Set[str] = set()

    for row in rows:
        handle = row.get("handle")

        if isinstance(handle, str) and handle:
            result.add(handle)

    return result


def get_last_published_creator() -> Optional[str]:
    rows = supabase_get(
        "videos",
        {
            "select": "creator_handle",
            "processing_status": "eq.ready",
            "is_active": "eq.true",
            "order": "last_processed_at.desc.nullslast",
            "limit": 1,
        },
    )

    if not rows:
        return None

    creator_handle = rows[0].get("creator_handle")

    if not isinstance(creator_handle, str):
        return None

    return creator_handle or None


def get_processing_video() -> Optional[Dict[str, Any]]:
    """
    Resume an unfinished Stream job before creating another one.

    This guarantees that one worker run concentrates on one video.
    """

    rows = supabase_get(
        "videos",
        {
            "select": "*",
            "processing_status": "eq.processing",
            "order": "last_processed_at.asc.nullsfirst",
            "limit": 1,
        },
    )

    return rows[0] if rows else None


def insert_processing_row(
    source: SourceVideo,
) -> Dict[str, Any]:

    payload = {
        "creator_handle": source.creator_handle,
        "video_number": source.video_number,
        "source_mp4": source.source_mp4,
        "file_size_bytes": source.file_size_bytes,

        "video_url": None,
        "manifest_url": None,
        "hls_url": None,
        "poster_url": None,
        "duration_seconds": None,

        "is_active": False,
        "created_by_worker": True,

        "processing_status": "processing",
        "hls_ready": False,

        "worker_version": WORKER_VERSION,
        "error_message": None,
        "last_processed_at": utc_now_iso(),
    }

    return supabase_insert(
        "videos",
        payload,
    )


def save_stream_uid_marker(
    source_mp4: str,
    stream_uid: str,
) -> None:
    """
    No new DB column is required for the first migration stage.

    During processing:
        video_url = cfstream://<UID>

    Once ready:
        video_url / manifest_url / hls_url = actual HLS URL

    UID remains recoverable from the final Cloudflare Stream HLS URL.
    """

    marker = f"{STREAM_UID_MARKER_PREFIX}{stream_uid}"

    supabase_patch(
        "videos",
        {
            "source_mp4": f"eq.{source_mp4}",
        },
        {
            "video_url": marker,
            "processing_status": "processing",
            "is_active": False,
            "hls_ready": False,
            "worker_version": WORKER_VERSION,
            "error_message": None,
            "last_processed_at": utc_now_iso(),
        },
    )


def mark_video_ready(
    source_mp4: str,
    stream_video: Dict[str, Any],
) -> None:

    playback = stream_video.get("playback") or {}

    hls_url = playback.get("hls")
    thumbnail_url = stream_video.get("thumbnail")
    duration = safe_float(
        stream_video.get("duration")
    )

    uid = stream_video.get("uid")

    if not isinstance(uid, str) or not uid:
        raise CloudflareStreamError(
            "Cloudflare ready response has no video UID"
        )

    if not isinstance(hls_url, str) or not hls_url:
        raise CloudflareStreamError(
            f"Cloudflare Stream video {uid} is ready "
            "but playback.hls is missing"
        )

    if not isinstance(thumbnail_url, str):
        thumbnail_url = None

    payload = {
        "video_url": hls_url,
        "manifest_url": hls_url,
        "hls_url": hls_url,
        "poster_url": thumbnail_url,
        "duration_seconds": duration,

        "processing_status": "ready",
        "hls_ready": True,
        "is_active": True,

        "created_by_worker": True,
        "worker_version": WORKER_VERSION,

        "error_message": None,
        "last_processed_at": utc_now_iso(),
    }

    supabase_patch(
        "videos",
        {
            "source_mp4": f"eq.{source_mp4}",
        },
        payload,
    )

    logger.info(
        "READY | source=%s | stream_uid=%s | hls=%s",
        source_mp4,
        uid,
        hls_url,
    )


def mark_video_failed(
    source_mp4: str,
    error: Any,
) -> None:

    error_text = truncate_error(error)

    supabase_patch(
        "videos",
        {
            "source_mp4": f"eq.{source_mp4}",
        },
        {
            "processing_status": "error",
            "hls_ready": False,
            "is_active": False,
            "worker_version": WORKER_VERSION,
            "error_message": error_text,
            "last_processed_at": utc_now_iso(),
        },
    )

    logger.error(
        "FAILED | source=%s | error=%s",
        source_mp4,
        error_text,
    )


# ============================================================
# R2 SOURCE DISCOVERY
# ============================================================


def list_source_videos() -> List[SourceVideo]:
    """
    Lists ONLY source MP4 objects matching:

        creators/<creator_handle>/<number>.mp4

    Existing historical HLS objects are ignored and untouched.
    """

    paginator = r2.get_paginator("list_objects_v2")

    result: List[SourceVideo] = []

    for page in paginator.paginate(
        Bucket=R2_BUCKET_NAME,
        Prefix=SOURCE_PREFIX,
    ):
        for item in page.get("Contents", []):
            key = item.get("Key")

            if not isinstance(key, str):
                continue

            match = SOURCE_PATTERN.match(key)

            if not match:
                continue

            creator_handle = match.group("creator_handle")
            video_number = int(
                match.group("video_number")
            )

            size = safe_int(
                item.get("Size"),
                0,
            )

            result.append(
                SourceVideo(
                    creator_handle=creator_handle,
                    video_number=video_number,
                    source_mp4=key,
                    file_size_bytes=size,
                )
            )

    result.sort(
        key=lambda item: (
            item.creator_handle.lower(),
            item.video_number,
            item.source_mp4,
        )
    )

    return result


def create_presigned_source_url(
    source_mp4: str,
) -> str:
    """
    The MP4 remains in R2.

    Hetzner does not download it.

    Cloudflare Stream receives a temporary authenticated
    HTTP URL and downloads the source directly from R2.
    """

    return r2.generate_presigned_url(
        ClientMethod="get_object",
        Params={
            "Bucket": R2_BUCKET_NAME,
            "Key": source_mp4,
        },
        ExpiresIn=R2_PRESIGNED_URL_SECONDS,
        HttpMethod="GET",
    )


# ============================================================
# SELECTION ENGINE V1
# ============================================================


def rotate_creator_order(
    creators: Sequence[str],
    last_creator: Optional[str],
) -> List[str]:
    """
    Deterministic creator rotation.

    Example:

        creators = A, B, C
        last = A
        next order = B, C, A

    This prevents immediate repetition when alternatives exist.
    """

    ordered = sorted(
        set(creators),
        key=str.lower,
    )

    if not ordered:
        return []

    if not last_creator:
        return ordered

    normalized_last = last_creator.lower()

    exact_index: Optional[int] = None

    for index, creator in enumerate(ordered):
        if creator.lower() == normalized_last:
            exact_index = index
            break

    if exact_index is not None:
        return (
            ordered[exact_index + 1 :]
            + ordered[: exact_index + 1]
        )

    # Last creator may currently have no pending source.
    # Find the first pending creator lexically after it,
    # then wrap around.
    split_index = 0

    for index, creator in enumerate(ordered):
        if creator.lower() > normalized_last:
            split_index = index
            break
    else:
        split_index = 0

    return (
        ordered[split_index:]
        + ordered[:split_index]
    )


def order_candidates_for_selection(
    candidates: Sequence[SourceVideo],
    last_creator: Optional[str],
) -> List[SourceVideo]:
    """
    Preserve creator rotation while selecting the lowest
    pending video number for each creator first.
    """

    by_creator: Dict[str, List[SourceVideo]] = {}

    for candidate in candidates:
        by_creator.setdefault(
            candidate.creator_handle,
            [],
        ).append(candidate)

    for creator_candidates in by_creator.values():
        creator_candidates.sort(
            key=lambda item: (
                item.video_number,
                item.source_mp4,
            )
        )

    creator_order = rotate_creator_order(
        list(by_creator.keys()),
        last_creator,
    )

    ordered_candidates: List[SourceVideo] = []

    # Round-robin flattening preserves rotation not only for
    # the first item but also for future extension.
    depth = 0

    while True:
        added = False

        for creator in creator_order:
            creator_candidates = by_creator[creator]

            if depth < len(creator_candidates):
                ordered_candidates.append(
                    creator_candidates[depth]
                )
                added = True

        if not added:
            break

        depth += 1

    return ordered_candidates


def select_next_source_video() -> Optional[SourceVideo]:
    sources = list_source_videos()

    if not sources:
        logger.info(
            "No source MP4 files found in R2"
        )
        return None

    known_sources = get_known_source_mp4s()
    known_creators = get_creator_handles()

    candidates: List[SourceVideo] = []

    for source in sources:
        if source.source_mp4 in known_sources:
            continue

        if source.creator_handle not in known_creators:
            logger.warning(
                "Skipping source with unknown creator | "
                "creator=%s | source=%s",
                source.creator_handle,
                source.source_mp4,
            )
            continue

        candidates.append(source)

    if not candidates:
        logger.info(
            "No new source MP4 files available"
        )
        return None

    last_creator = get_last_published_creator()

    ordered = order_candidates_for_selection(
        candidates,
        last_creator,
    )

    if not ordered:
        return None

    selected = ordered[0]

    logger.info(
        "SELECTED | creator=%s | video=%s | source=%s | "
        "last_creator=%s",
        selected.creator_handle,
        selected.video_number,
        selected.source_mp4,
        last_creator or "-",
    )

    return selected


# ============================================================
# CLOUDFLARE STREAM API
# ============================================================


CLOUDFLARE_API_BASE = (
    "https://api.cloudflare.com/client/v4"
)


def cloudflare_headers() -> Dict[str, str]:
    return {
        "Authorization": (
            f"Bearer {CLOUDFLARE_STREAM_API_TOKEN}"
        ),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def cloudflare_request(
    method: str,
    path: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    json_body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:

    url = f"{CLOUDFLARE_API_BASE}{path}"

    response = http.request(
        method=method,
        url=url,
        headers=cloudflare_headers(),
        params=params,
        json=json_body,
        timeout=(HTTP_CONNECT_TIMEOUT, HTTP_READ_TIMEOUT),
    )

    try:
        payload = response.json()
    except ValueError:
        raise CloudflareStreamError(
            f"Cloudflare returned non-JSON response: "
            f"HTTP {response.status_code}: {response.text}"
        )

    if not response.ok:
        raise CloudflareStreamError(
            f"Cloudflare API HTTP {response.status_code}: "
            f"{payload}"
        )

    if payload.get("success") is not True:
        raise CloudflareStreamError(
            f"Cloudflare API request failed: "
            f"{payload.get('errors') or payload}"
        )

    return payload


def stream_copy_from_r2(
    source: SourceVideo,
) -> Dict[str, Any]:

    source_url = create_presigned_source_url(
        source.source_mp4
    )

    payload = {
        "url": source_url,
        "meta": {
            # Exact deterministic identity used for
            # crash recovery and duplicate protection.
            "name": source.source_mp4,

            "source_mp4": source.source_mp4,
            "creator_handle": source.creator_handle,
            "video_number": str(source.video_number),
            "worker": WORKER_VERSION,
        },
    }

    logger.info(
        "STREAM CREATE | source=%s",
        source.source_mp4,
    )

    response = cloudflare_request(
        "POST",
        (
            f"/accounts/{CLOUDFLARE_ACCOUNT_ID}"
            "/stream/copy"
        ),
        json_body=payload,
    )

    result = response.get("result")

    if not isinstance(result, dict):
        raise CloudflareStreamError(
            "Cloudflare Stream copy returned no result object"
        )

    uid = result.get("uid")

    if not isinstance(uid, str) or not uid:
        raise CloudflareStreamError(
            "Cloudflare Stream copy returned no UID"
        )

    logger.info(
        "STREAM UID | source=%s | uid=%s",
        source.source_mp4,
        uid,
    )

    return result


def get_stream_video(
    uid: str,
) -> Dict[str, Any]:

    response = cloudflare_request(
        "GET",
        (
            f"/accounts/{CLOUDFLARE_ACCOUNT_ID}"
            f"/stream/{uid}"
        ),
    )

    result = response.get("result")

    if not isinstance(result, dict):
        raise CloudflareStreamError(
            f"Cloudflare Stream returned no details for {uid}"
        )

    return result


def find_stream_video_by_source(
    source_mp4: str,
) -> Optional[Dict[str, Any]]:
    """
    Exact metadata-name reconciliation.

    Protects against the crash window:

        Stream accepted upload
        ->
        process died
        ->
        Supabase UID marker was not written

    The next run looks up the already-created Stream video
    instead of submitting another copy.
    """

    response = cloudflare_request(
        "GET",
        (
            f"/accounts/{CLOUDFLARE_ACCOUNT_ID}"
            "/stream"
        ),
        params={
            "video_name": source_mp4,
            "limit": 10,
        },
    )

    results = response.get("result")

    if not isinstance(results, list):
        return None

    matches: List[Dict[str, Any]] = []

    for item in results:
        if not isinstance(item, dict):
            continue

        meta = item.get("meta")

        if not isinstance(meta, dict):
            continue

        if meta.get("name") == source_mp4:
            matches.append(item)

    if not matches:
        return None

    # If historical duplicate objects somehow already exist,
    # reuse the oldest matching UID rather than creating another.
    matches.sort(
        key=lambda item: (
            str(item.get("created") or ""),
            str(item.get("uid") or ""),
        )
    )

    selected = matches[0]

    uid = selected.get("uid")

    if isinstance(uid, str) and uid:
        logger.info(
            "STREAM RECOVERED | source=%s | uid=%s",
            source_mp4,
            uid,
        )

        return selected

    return None


# ============================================================
# STREAM UID EXTRACTION
# ============================================================


STREAM_URL_UID_PATTERN = re.compile(
    r"cloudflarestream\.com/"
    r"(?P<uid>[A-Za-z0-9_-]{10,64})/"
)


def extract_stream_uid_from_value(
    value: Any,
) -> Optional[str]:

    if not isinstance(value, str):
        return None

    value = value.strip()

    if not value:
        return None

    if value.startswith(STREAM_UID_MARKER_PREFIX):
        uid = value[len(STREAM_UID_MARKER_PREFIX) :].strip()

        return uid or None

    match = STREAM_URL_UID_PATTERN.search(value)

    if match:
        return match.group("uid")

    return None


def extract_stream_uid_from_row(
    row: Dict[str, Any],
) -> Optional[str]:

    for column in (
        "video_url",
        "manifest_url",
        "hls_url",
        "poster_url",
    ):
        uid = extract_stream_uid_from_value(
            row.get(column)
        )

        if uid:
            return uid

    return None


# ============================================================
# STREAM PROCESSING
# ============================================================


def wait_for_stream_ready(
    uid: str,
) -> Optional[Dict[str, Any]]:
    """
    Returns:
        Stream result when fully ready.

    Returns None:
        Processing still continues after the configured
        wait window. Supabase remains "processing" and the
        next worker run resumes the SAME Stream UID.

    Raises:
        CloudflareStreamProcessingError when Stream itself
        reports an encoding/processing error.
    """

    deadline = time.monotonic() + STREAM_WAIT_SECONDS

    while True:
        video = get_stream_video(uid)

        status = video.get("status") or {}

        state = status.get("state")
        pct_complete = status.get("pctComplete")
        ready_to_stream = (
            video.get("readyToStream") is True
        )

        logger.info(
            "STREAM STATUS | uid=%s | state=%s | "
            "pct=%s | readyToStream=%s",
            uid,
            state,
            pct_complete,
            ready_to_stream,
        )

        if state == "error":
            reason_code = (
                status.get("errorReasonCode")
                or "UNKNOWN"
            )

            reason_text = (
                status.get("errorReasonText")
                or "Cloudflare Stream processing failed"
            )

            raise CloudflareStreamProcessingError(
                f"{reason_code}: {reason_text}"
            )

        if state == "ready" and ready_to_stream:
            playback = video.get("playback") or {}

            if playback.get("hls"):
                return video

        if time.monotonic() >= deadline:
            return None

        time.sleep(STREAM_POLL_SECONDS)


# ============================================================
# PROCESS / RESUME VIDEO
# ============================================================


def source_from_row(
    row: Dict[str, Any],
) -> SourceVideo:

    source_mp4 = row.get("source_mp4")
    creator_handle = row.get("creator_handle")
    video_number = row.get("video_number")
    file_size_bytes = row.get("file_size_bytes")

    if not isinstance(source_mp4, str) or not source_mp4:
        raise RuntimeError(
            "Processing row has no source_mp4"
        )

    if not isinstance(creator_handle, str) or not creator_handle:
        match = SOURCE_PATTERN.match(source_mp4)

        if not match:
            raise RuntimeError(
                f"Cannot recover creator from {source_mp4}"
            )

        creator_handle = match.group(
            "creator_handle"
        )

    if video_number is None:
        match = SOURCE_PATTERN.match(source_mp4)

        if not match:
            raise RuntimeError(
                f"Cannot recover video number from {source_mp4}"
            )

        video_number = int(
            match.group("video_number")
        )

    return SourceVideo(
        creator_handle=creator_handle,
        video_number=safe_int(video_number),
        source_mp4=source_mp4,
        file_size_bytes=safe_int(
            file_size_bytes,
            0,
        ),
    )


def acquire_stream_uid(
    source: SourceVideo,
    row: Dict[str, Any],
) -> str:
    """
    Acquisition priority:

    1. UID already persisted in Supabase.
    2. Existing Stream video found by exact source metadata.
    3. Create a new Stream copy from the R2 source.

    This is the central idempotency path.
    """

    uid = extract_stream_uid_from_row(row)

    if uid:
        logger.info(
            "STREAM RESUME | source=%s | uid=%s",
            source.source_mp4,
            uid,
        )

        return uid

    recovered = find_stream_video_by_source(
        source.source_mp4
    )

    if recovered:
        recovered_uid = recovered.get("uid")

        if isinstance(recovered_uid, str) and recovered_uid:
            save_stream_uid_marker(
                source.source_mp4,
                recovered_uid,
            )

            return recovered_uid

    created = stream_copy_from_r2(source)

    uid = created.get("uid")

    if not isinstance(uid, str) or not uid:
        raise CloudflareStreamError(
            "New Stream video has no UID"
        )

    # Persist immediately after Cloudflare returns it.
    save_stream_uid_marker(
        source.source_mp4,
        uid,
    )

    return uid


def process_video(
    row: Dict[str, Any],
) -> None:

    source = source_from_row(row)

    logger.info(
        "PROCESS | creator=%s | video=%s | source=%s",
        source.creator_handle,
        source.video_number,
        source.source_mp4,
    )

    try:
        if not creator_exists(
            source.creator_handle
        ):
            raise RuntimeError(
                f"Creator does not exist in Supabase: "
                f"{source.creator_handle}"
            )

        uid = acquire_stream_uid(
            source,
            row,
        )

        stream_video = wait_for_stream_ready(
            uid
        )

        if stream_video is None:
            # This is NOT an error.
            #
            # Stream continues processing.
            # The next worker run resumes this exact UID.
            supabase_patch(
                "videos",
                {
                    "source_mp4": (
                        f"eq.{source.source_mp4}"
                    ),
                },
                {
                    "processing_status": "processing",
                    "hls_ready": False,
                    "is_active": False,
                    "worker_version": WORKER_VERSION,
                    "error_message": None,
                    "last_processed_at": utc_now_iso(),
                },
            )

            logger.info(
                "STREAM STILL PROCESSING | "
                "source=%s | uid=%s",
                source.source_mp4,
                uid,
            )

            return

        mark_video_ready(
            source.source_mp4,
            stream_video,
        )

    except Exception as exc:
        mark_video_failed(
            source.source_mp4,
            exc,
        )

        raise


# ============================================================
# PREFLIGHT
# ============================================================


def preflight() -> None:
    """
    Local configuration validation only.

    No destructive operations.
    No FFmpeg.
    No storage mutation.
    """

    if STREAM_POLL_SECONDS <= 0:
        raise RuntimeError(
            "STREAM_POLL_SECONDS must be > 0"
        )

    if STREAM_WAIT_SECONDS <= 0:
        raise RuntimeError(
            "STREAM_WAIT_SECONDS must be > 0"
        )

    if R2_PRESIGNED_URL_SECONDS <= 0:
        raise RuntimeError(
            "R2_PRESIGNED_URL_SECONDS must be > 0"
        )

    logger.info(
        "Tikboo worker starting | version=%s",
        WORKER_VERSION,
    )


# ============================================================
# MAIN
# ============================================================


def main() -> int:
    preflight()

    # --------------------------------------------------------
    # 1. Resume unfinished processing first.
    # --------------------------------------------------------

    processing_row = get_processing_video()

    if processing_row is not None:
        logger.info(
            "Resuming existing processing row | source=%s",
            processing_row.get("source_mp4"),
        )

        process_video(
            processing_row
        )

        return 0

    # --------------------------------------------------------
    # 2. Selection Engine chooses at most one NEW video.
    # --------------------------------------------------------

    selected = select_next_source_video()

    if selected is None:
        logger.info(
            "Worker finished | nothing to process"
        )

        return 0

    # --------------------------------------------------------
    # 3. Defensive recheck immediately before DB insert.
    # --------------------------------------------------------

    existing = get_video_by_source(
        selected.source_mp4
    )

    if existing is not None:
        logger.info(
            "Source already exists in Supabase | source=%s",
            selected.source_mp4,
        )

        return 0

    # --------------------------------------------------------
    # 4. Create durable processing state BEFORE Stream ingest.
    # --------------------------------------------------------

    row = insert_processing_row(
        selected
    )

    # --------------------------------------------------------
    # 5. R2 source -> Cloudflare Stream -> Supabase.
    # --------------------------------------------------------

    process_video(
        row
    )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())

    except KeyboardInterrupt:
        logger.warning(
            "Worker interrupted"
        )
        sys.exit(130)

    except Exception:
        logger.exception(
            "Worker terminated with error"
        )
        sys.exit(1)
