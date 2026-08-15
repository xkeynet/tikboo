#!/opt/tikboo-worker/venv/bin/python

from __future__ import annotations

import logging
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import boto3
import requests
from botocore.config import Config as BotoConfig
from dotenv import load_dotenv


# ============================================================
# TIKBOO VIDEO WORKER
# ============================================================
#
# PRODUCTION ARCHITECTURE
#
# R2
#   Source MP4 storage only.
#
# Hetzner
#   Discovery, creator selection, orchestration.
#
# Cloudflare Stream
#   Video ingest, transcoding, HLS packaging and playback.
#
# Supabase
#   Processing state and playback metadata.
#
# This worker NEVER:
#
#   - runs FFmpeg
#   - runs ffprobe
#   - downloads source MP4 to Hetzner
#   - creates poster.webp
#   - creates index.m3u8
#   - creates .ts segments
#   - creates .m4s segments
#   - creates init.mp4
#   - uploads playback files into R2
#
# Source MP4 files remain untouched:
#
#   creators/<creator_handle>/001.mp4
#   creators/<creator_handle>/002.mp4
#   ...
#
# ============================================================


# ============================================================
# VERSION
# ============================================================


WORKER_VERSION = "stream-2.0.0"


# ============================================================
# PATHS / ENV
# ============================================================


BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"

load_dotenv(ENV_FILE)


# ============================================================
# EXISTING PRODUCTION ENVIRONMENT
# ============================================================


R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY"]
R2_SECRET_KEY = os.environ["R2_SECRET_KEY"]
R2_BUCKET = os.environ["R2_BUCKET"]

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]


# ============================================================
# NEW CLOUDFLARE STREAM ENVIRONMENT
# ============================================================


CLOUDFLARE_ACCOUNT_ID = os.environ["CLOUDFLARE_ACCOUNT_ID"]
CLOUDFLARE_STREAM_API_TOKEN = os.environ[
    "CLOUDFLARE_STREAM_API_TOKEN"
]


# ============================================================
# OPTIONAL WORKER SETTINGS
# ============================================================


STREAM_POLL_SECONDS = int(
    os.getenv(
        "STREAM_POLL_SECONDS",
        "10",
    )
)

STREAM_WAIT_SECONDS = int(
    os.getenv(
        "STREAM_WAIT_SECONDS",
        "1200",
    )
)

R2_PRESIGNED_URL_SECONDS = int(
    os.getenv(
        "R2_PRESIGNED_URL_SECONDS",
        "21600",
    )
)


# ============================================================
# CONSTANTS
# ============================================================


CREATORS_PREFIX = "creators/"

SOURCE_PATTERN = re.compile(
    r"^creators/([^/]+)/(\d+)\.mp4$",
    re.IGNORECASE,
)

CLOUDFLARE_API_BASE = (
    "https://api.cloudflare.com/client/v4"
)

STREAM_UID_MARKER_PREFIX = "cfstream://"

HTTP_TIMEOUT_SECONDS = 60


# ============================================================
# LOGGING
# ============================================================


logging.basicConfig(
    level=logging.INFO,
    format=(
        "%(asctime)s | "
        "%(levelname)s | "
        "%(message)s"
    ),
)

logger = logging.getLogger(
    "tikboo-worker"
)


# ============================================================
# HTTP SESSION
# ============================================================


http = requests.Session()

http.headers.update(
    {
        "User-Agent": (
            f"TikbooWorker/{WORKER_VERSION}"
        ),
    }
)


# ============================================================
# R2 CLIENT
# ============================================================


s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY,
    aws_secret_access_key=R2_SECRET_KEY,
    region_name="auto",
    config=BotoConfig(
        signature_version="s3v4",
        retries={
            "max_attempts": 5,
            "mode": "standard",
        },
    ),
)


# ============================================================
# EXCEPTIONS
# ============================================================


class CloudflareStreamError(
    RuntimeError
):
    pass


class CloudflareStreamProcessingError(
    CloudflareStreamError
):
    pass


# ============================================================
# GENERIC HELPERS
# ============================================================


def now_iso():
    return datetime.now(
        timezone.utc
    ).isoformat()


def truncate_error(
    value,
    limit=4000,
):
    text = str(value)

    if len(text) <= limit:
        return text

    return text[:limit]


def duration_to_int(
    value,
):
    if value is None:
        return None

    try:
        duration = float(value)
    except (
        TypeError,
        ValueError,
    ):
        return None

    if duration < 0:
        return None

    return int(
        round(duration)
    )


# ============================================================
# SUPABASE
# ============================================================


def supabase_headers(
    prefer="return=representation",
):
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": (
            f"Bearer {SUPABASE_KEY}"
        ),
        "Content-Type": (
            "application/json"
        ),
        "Accept": (
            "application/json"
        ),
    }

    if prefer:
        headers["Prefer"] = prefer

    return headers


def supabase_get(
    table,
    params,
):
    response = http.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers(),
        params=params,
        timeout=HTTP_TIMEOUT_SECONDS,
    )

    response.raise_for_status()

    rows = response.json()

    if not isinstance(
        rows,
        list,
    ):
        raise RuntimeError(
            f"Unexpected Supabase response "
            f"for table {table}."
        )

    return rows


def supabase_insert(
    table,
    payload,
):
    response = http.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers(
            "return=representation"
        ),
        json=payload,
        timeout=HTTP_TIMEOUT_SECONDS,
    )

    response.raise_for_status()

    rows = response.json()

    if (
        not isinstance(rows, list)
        or not rows
    ):
        raise RuntimeError(
            f"Supabase did not return "
            f"inserted {table} row."
        )

    return rows[0]


def supabase_patch(
    table,
    params,
    payload,
):
    response = http.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers(
            "return=minimal"
        ),
        params=params,
        json=payload,
        timeout=HTTP_TIMEOUT_SECONDS,
    )

    response.raise_for_status()


# ============================================================
# SOURCE VIDEO DISCOVERY
# ============================================================


def list_source_videos():
    """
    Read ONLY original source MP4 objects:

        creators/<creator_handle>/<number>.mp4

    Historical folders such as:

        creators/<creator>/001/index.m3u8
        creators/<creator>/001/poster.webp
        creators/<creator>/001/segment_*.ts
        creators/<creator>/001/segment_*.m4s

    do not match SOURCE_PATTERN and are ignored.
    """

    paginator = s3.get_paginator(
        "list_objects_v2"
    )

    videos = []

    for page in paginator.paginate(
        Bucket=R2_BUCKET,
        Prefix=CREATORS_PREFIX,
    ):
        for obj in page.get(
            "Contents",
            [],
        ):
            key = obj["Key"]

            match = SOURCE_PATTERN.match(
                key
            )

            if not match:
                continue

            creator_handle = (
                match.group(1)
            )

            video_number = int(
                match.group(2)
            )

            videos.append(
                {
                    "key": key,
                    "creator_handle": (
                        creator_handle
                    ),
                    "video_number": (
                        video_number
                    ),
                    "size": int(
                        obj.get(
                            "Size",
                            0,
                        )
                    ),
                }
            )

    videos.sort(
        key=lambda item: (
            item[
                "creator_handle"
            ].lower(),
            item[
                "video_number"
            ],
        )
    )

    return videos


# ============================================================
# SELECTION ENGINE V1
# ============================================================
#
# IMPORTANT:
#
# This logic intentionally preserves the actual production
# Selection Engine from the original Hetzner worker.
#
# - one worker run = maximum one newly selected video
# - creators are randomized
# - most recently published creator is avoided when alternatives
#   exist
# - videos inside one creator remain numerically ordered
# - candidates are interleaved across creators
#
# ============================================================


def order_candidates_for_selection(
    videos,
):
    if not videos:
        return []

    by_creator = {}

    for video in videos:
        by_creator.setdefault(
            video[
                "creator_handle"
            ],
            [],
        ).append(
            video
        )

    for creator_videos in (
        by_creator.values()
    ):
        creator_videos.sort(
            key=lambda item: (
                item[
                    "video_number"
                ]
            )
        )

    last_creator = None

    try:
        response = requests.get(
            (
                f"{SUPABASE_URL}"
                "/rest/v1/videos"
            ),
            headers=supabase_headers(),
            params={
                "select": (
                    "creator_handle"
                ),
                "processing_status": (
                    "eq.ready"
                ),
                "order": (
                    "created_at.desc"
                ),
                "limit": "1",
            },
            timeout=30,
        )

        response.raise_for_status()

        rows = response.json()

        if rows:
            last_creator = (
                rows[0].get(
                    "creator_handle"
                )
            )

    except Exception as exc:
        logger.warning(
            "Selection Engine: "
            "could not read last "
            "creator: %s",
            exc,
        )

    creators = list(
        by_creator.keys()
    )

    random.SystemRandom().shuffle(
        creators
    )

    if (
        last_creator
        and len(creators) > 1
        and last_creator in creators
    ):
        creators.remove(
            last_creator
        )

        creators.append(
            last_creator
        )

    ordered = []

    while True:
        added = False

        for creator in creators:
            creator_videos = (
                by_creator[
                    creator
                ]
            )

            if creator_videos:
                ordered.append(
                    creator_videos.pop(
                        0
                    )
                )

                added = True

        if not added:
            break

    logger.info(
        "Selection Engine v1 | "
        "creators=%s | "
        "source_candidates=%s",
        len(creators),
        len(ordered),
    )

    if last_creator:
        logger.info(
            "Last ready creator | %s",
            last_creator,
        )

    return ordered


# ============================================================
# SUPABASE VIDEO LOOKUP
# ============================================================


def get_video_by_source(
    source_mp4,
):
    rows = supabase_get(
        "videos",
        {
            "select": "*",
            "source_mp4": (
                f"eq.{source_mp4}"
            ),
            "limit": "1",
        },
    )

    return (
        rows[0]
        if rows
        else None
    )


def video_exists_in_supabase(
    source_mp4,
):
    """
    Preserve production semantics.

    A row for source_mp4 means this source has already entered
    the processing pipeline.

    The caller decides whether to resume processing or skip.
    """

    return get_video_by_source(
        source_mp4
    )


def creator_exists(
    handle,
):
    response = requests.get(
        (
            f"{SUPABASE_URL}"
            "/rest/v1/creators"
        ),
        headers=supabase_headers(),
        params={
            "select": (
                "id,handle"
            ),
            "handle": (
                f"eq.{handle}"
            ),
            "limit": "1",
        },
        timeout=30,
    )

    response.raise_for_status()

    rows = response.json()

    return bool(rows)


def get_processing_video():
    """
    Resume an existing Stream processing row before creating
    another Stream upload.

    This is critical for idempotency.

    If a server restarts while Cloudflare Stream is encoding,
    the next worker run continues that same source video rather
    than selecting a new one.
    """

    rows = supabase_get(
        "videos",
        {
            "select": "*",
            "processing_status": (
                "eq.processing"
            ),
            "order": (
                "created_at.asc"
            ),
            "limit": "1",
        },
    )

    return (
        rows[0]
        if rows
        else None
    )


# ============================================================
# SUPABASE PROCESSING STATE
# ============================================================


def insert_processing_row(
    video,
):
    """
    Create durable DB state BEFORE sending the source MP4 to
    Cloudflare Stream.

    No playback URL exists at this point.
    """

    payload = {
        "creator_handle": (
            video[
                "creator_handle"
            ]
        ),
        "video_url": None,
        "manifest_url": None,
        "poster_url": None,
        "hls_url": None,
        "video_number": (
            video[
                "video_number"
            ]
        ),
        "is_active": False,
        "created_by_worker": True,
        "processing_status": (
            "processing"
        ),
        "duration_seconds": None,
        "file_size_bytes": (
            video[
                "size"
            ]
        ),
        "source_mp4": (
            video[
                "key"
            ]
        ),
        "hls_ready": False,
        "worker_version": (
            WORKER_VERSION
        ),
        "last_processed_at": (
            now_iso()
        ),
        "error_message": None,
    }

    return supabase_insert(
        "videos",
        payload,
    )


def save_stream_uid(
    row_id,
    stream_uid,
):
    """
    Current Supabase schema has no dedicated stream_uid column.

    Until a deliberate DB migration adds one, the UID is stored
    DURING PROCESSING in video_url as:

        cfstream://<uid>

    The row remains:
        processing_status = processing
        is_active = false
        hls_ready = false

    Therefore this marker can never be exposed as an active feed
    playback URL.

    Once Stream is ready, video_url is replaced with the real
    Cloudflare Stream HLS URL.
    """

    marker = (
        STREAM_UID_MARKER_PREFIX
        + stream_uid
    )

    supabase_patch(
        "videos",
        {
            "id": (
                f"eq.{row_id}"
            ),
        },
        {
            "video_url": marker,
            "processing_status": (
                "processing"
            ),
            "hls_ready": False,
            "is_active": False,
            "worker_version": (
                WORKER_VERSION
            ),
            "last_processed_at": (
                now_iso()
            ),
            "error_message": None,
        },
    )


def mark_video_processing(
    row_id,
):
    supabase_patch(
        "videos",
        {
            "id": (
                f"eq.{row_id}"
            ),
        },
        {
            "processing_status": (
                "processing"
            ),
            "hls_ready": False,
            "is_active": False,
            "worker_version": (
                WORKER_VERSION
            ),
            "last_processed_at": (
                now_iso()
            ),
            "error_message": None,
        },
    )


def mark_video_ready(
    row_id,
    stream_video,
):
    """
    Cloudflare Stream is authoritative for playback.

    We reuse the existing Supabase playback columns:

        video_url
        manifest_url
        hls_url
        poster_url

    No R2 playback path is written.
    """

    uid = stream_video.get(
        "uid"
    )

    if not uid:
        raise CloudflareStreamError(
            "Cloudflare Stream ready "
            "response has no UID."
        )

    playback = (
        stream_video.get(
            "playback"
        )
        or {}
    )

    hls_url = playback.get(
        "hls"
    )

    if not hls_url:
        raise CloudflareStreamError(
            "Cloudflare Stream video "
            f"{uid} is ready but "
            "playback.hls is missing."
        )

    poster_url = (
        stream_video.get(
            "thumbnail"
        )
    )

    if not poster_url:
        raise CloudflareStreamError(
            "Cloudflare Stream video "
            f"{uid} is ready but "
            "thumbnail is missing."
        )

    duration_seconds = (
        duration_to_int(
            stream_video.get(
                "duration"
            )
        )
    )

    payload = {
        "video_url": (
            hls_url
        ),
        "manifest_url": (
            hls_url
        ),
        "poster_url": (
            poster_url
        ),
        "hls_url": (
            hls_url
        ),
        "is_active": True,
        "created_by_worker": True,
        "processing_status": (
            "ready"
        ),
        "duration_seconds": (
            duration_seconds
        ),
        "hls_ready": True,
        "worker_version": (
            WORKER_VERSION
        ),
        "last_processed_at": (
            now_iso()
        ),
        "error_message": None,
    }

    supabase_patch(
        "videos",
        {
            "id": (
                f"eq.{row_id}"
            ),
        },
        payload,
    )

    logger.info(
        "READY | row_id=%s | "
        "stream_uid=%s | "
        "hls=%s",
        row_id,
        uid,
        hls_url,
    )


def mark_video_failed(
    row_id,
    error_message,
):
    payload = {
        "processing_status": (
            "error"
        ),
        "hls_ready": False,
        "is_active": False,
        "worker_version": (
            WORKER_VERSION
        ),
        "last_processed_at": (
            now_iso()
        ),
        "error_message": (
            truncate_error(
                error_message
            )
        ),
    }

    supabase_patch(
        "videos",
        {
            "id": (
                f"eq.{row_id}"
            ),
        },
        payload,
    )


# ============================================================
# R2 PRESIGNED SOURCE URL
# ============================================================


def create_presigned_source_url(
    source_key,
):
    """
    Cloudflare Stream fetches the original MP4 directly from R2.

    Hetzner does not download the MP4.
    Hetzner does not transcode the MP4.
    Hetzner does not create playback segments.

    The source object itself remains unchanged in R2.
    """

    return s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={
            "Bucket": R2_BUCKET,
            "Key": source_key,
        },
        ExpiresIn=(
            R2_PRESIGNED_URL_SECONDS
        ),
        HttpMethod="GET",
    )


# ============================================================
# CLOUDFLARE STREAM API
# ============================================================


def cloudflare_headers():
    return {
        "Authorization": (
            "Bearer "
            + CLOUDFLARE_STREAM_API_TOKEN
        ),
        "Content-Type": (
            "application/json"
        ),
        "Accept": (
            "application/json"
        ),
    }


def cloudflare_request(
    method,
    path,
    params=None,
    json_body=None,
):
    url = (
        CLOUDFLARE_API_BASE
        + path
    )

    response = http.request(
        method=method,
        url=url,
        headers=cloudflare_headers(),
        params=params,
        json=json_body,
        timeout=HTTP_TIMEOUT_SECONDS,
    )

    try:
        payload = response.json()
    except ValueError:
        raise CloudflareStreamError(
            "Cloudflare returned "
            "non-JSON response: "
            f"HTTP {response.status_code}: "
            f"{response.text}"
        )

    if not response.ok:
        raise CloudflareStreamError(
            "Cloudflare API HTTP "
            f"{response.status_code}: "
            f"{payload}"
        )

    if payload.get(
        "success"
    ) is not True:
        raise CloudflareStreamError(
            "Cloudflare API request "
            f"failed: "
            f"{payload.get('errors')}"
        )

    return payload


# ============================================================
# STREAM DUPLICATE PROTECTION
# ============================================================


def find_stream_video_by_source(
    source_mp4,
):
    """
    Cloudflare Stream supports video_name as a fast exact match
    against meta.name.

    Every Tikboo Stream upload stores:

        meta.name = creators/<handle>/<number>.mp4

    Therefore if Cloudflare accepted an upload and Hetzner died
    before saving the UID to Supabase, the next worker run can
    recover the existing Stream object instead of uploading the
    same source twice.
    """

    response = cloudflare_request(
        "GET",
        (
            f"/accounts/"
            f"{CLOUDFLARE_ACCOUNT_ID}"
            "/stream"
        ),
        params={
            "video_name": (
                source_mp4
            ),
            "limit": 10,
        },
    )

    results = response.get(
        "result"
    )

    if not isinstance(
        results,
        list,
    ):
        return None

    matches = []

    for item in results:
        if not isinstance(
            item,
            dict,
        ):
            continue

        meta = (
            item.get(
                "meta"
            )
            or {}
        )

        if (
            isinstance(meta, dict)
            and meta.get("name")
            == source_mp4
        ):
            matches.append(
                item
            )

    if not matches:
        return None

    # Deterministically prefer the oldest exact match.
    #
    # Under normal operation there must be only one.
    matches.sort(
        key=lambda item: (
            str(
                item.get(
                    "created"
                )
                or ""
            ),
            str(
                item.get(
                    "uid"
                )
                or ""
            ),
        )
    )

    selected = matches[0]

    uid = selected.get(
        "uid"
    )

    if not uid:
        return None

    logger.info(
        "STREAM RECOVERY | "
        "source=%s | uid=%s",
        source_mp4,
        uid,
    )

    return selected


# ============================================================
# STREAM UPLOAD FROM R2
# ============================================================


def create_stream_video(
    video,
):
    """
    R2 source MP4 -> Cloudflare Stream.

    Cloudflare Stream receives a temporary presigned HTTP URL
    and fetches the original source itself.
    """

    source_key = video[
        "key"
    ]

    source_url = (
        create_presigned_source_url(
            source_key
        )
    )

    payload = {
        "url": source_url,
        "meta": {
            "name": (
                source_key
            ),
            "source_mp4": (
                source_key
            ),
            "creator_handle": (
                video[
                    "creator_handle"
                ]
            ),
            "video_number": str(
                video[
                    "video_number"
                ]
            ),
            "worker_version": (
                WORKER_VERSION
            ),
        },
    }

    logger.info(
        "STREAM CREATE | source=%s",
        source_key,
    )

    response = cloudflare_request(
        "POST",
        (
            f"/accounts/"
            f"{CLOUDFLARE_ACCOUNT_ID}"
            "/stream/copy"
        ),
        json_body=payload,
    )

    result = response.get(
        "result"
    )

    if not isinstance(
        result,
        dict,
    ):
        raise CloudflareStreamError(
            "Cloudflare Stream copy "
            "returned no result object."
        )

    uid = result.get(
        "uid"
    )

    if not uid:
        raise CloudflareStreamError(
            "Cloudflare Stream copy "
            "returned no UID."
        )

    logger.info(
        "STREAM CREATED | "
        "source=%s | uid=%s",
        source_key,
        uid,
    )

    return result


# ============================================================
# STREAM VIDEO DETAILS
# ============================================================


def get_stream_video(
    uid,
):
    response = cloudflare_request(
        "GET",
        (
            f"/accounts/"
            f"{CLOUDFLARE_ACCOUNT_ID}"
            f"/stream/{uid}"
        ),
    )

    result = response.get(
        "result"
    )

    if not isinstance(
        result,
        dict,
    ):
        raise CloudflareStreamError(
            "Cloudflare Stream "
            f"returned no video "
            f"details for UID {uid}."
        )

    return result


# ============================================================
# STREAM UID RECOVERY FROM SUPABASE
# ============================================================


STREAM_URL_UID_PATTERN = re.compile(
    r"cloudflarestream\.com/"
    r"([A-Za-z0-9_-]{10,64})/"
)


def extract_stream_uid_from_value(
    value,
):
    if not isinstance(
        value,
        str,
    ):
        return None

    value = value.strip()

    if not value:
        return None

    if value.startswith(
        STREAM_UID_MARKER_PREFIX
    ):
        uid = value[
            len(
                STREAM_UID_MARKER_PREFIX
            ):
        ].strip()

        return (
            uid
            if uid
            else None
        )

    match = (
        STREAM_URL_UID_PATTERN.search(
            value
        )
    )

    if match:
        return match.group(1)

    return None


def extract_stream_uid_from_row(
    row,
):
    """
    During processing the UID normally lives in video_url as
    cfstream://UID.

    This helper also recognizes final Cloudflare playback URLs,
    making state recovery more defensive.
    """

    for column in (
        "video_url",
        "manifest_url",
        "hls_url",
        "poster_url",
    ):
        uid = (
            extract_stream_uid_from_value(
                row.get(
                    column
                )
            )
        )

        if uid:
            return uid

    return None


# ============================================================
# ACQUIRE STREAM UID
# ============================================================


def acquire_stream_uid(
    row,
    video,
):
    """
    Idempotency order:

    1. Reuse UID already persisted in Supabase.
    2. Search Cloudflare Stream using exact meta.name.
    3. Only if neither exists, create a new Stream upload.

    This protects against server restarts and crashes.
    """

    source_mp4 = video[
        "key"
    ]

    uid = (
        extract_stream_uid_from_row(
            row
        )
    )

    if uid:
        logger.info(
            "STREAM RESUME | "
            "source=%s | uid=%s",
            source_mp4,
            uid,
        )

        return uid

    recovered = (
        find_stream_video_by_source(
            source_mp4
        )
    )

    if recovered:
        recovered_uid = (
            recovered.get(
                "uid"
            )
        )

        if recovered_uid:
            save_stream_uid(
                row["id"],
                recovered_uid,
            )

            return recovered_uid

    created = (
        create_stream_video(
            video
        )
    )

    uid = created.get(
        "uid"
    )

    if not uid:
        raise CloudflareStreamError(
            "Created Stream video "
            "has no UID."
        )

    # Critical durability point:
    #
    # Save UID immediately after Cloudflare returns it.
    save_stream_uid(
        row["id"],
        uid,
    )

    return uid


# ============================================================
# WAIT FOR CLOUDFLARE STREAM
# ============================================================


def wait_for_stream_ready(
    uid,
):
    """
    Poll Cloudflare Stream until:

        readyToStream == true

    or until Stream reports an error.

    If the configured wait window ends while processing is still
    valid, return None and leave Supabase in processing state.
    The next worker run resumes the same Stream UID.
    """

    deadline = (
        time.monotonic()
        + STREAM_WAIT_SECONDS
    )

    while True:
        video = (
            get_stream_video(
                uid
            )
        )

        status = (
            video.get(
                "status"
            )
            or {}
        )

        state = status.get(
            "state"
        )

        pct_complete = (
            status.get(
                "pctComplete"
            )
        )

        ready_to_stream = (
            video.get(
                "readyToStream"
            )
            is True
        )

        logger.info(
            "STREAM STATUS | "
            "uid=%s | state=%s | "
            "pct=%s | ready=%s",
            uid,
            state,
            pct_complete,
            ready_to_stream,
        )

        if state == "error":
            reason_code = (
                status.get(
                    "errorReasonCode"
                )
                or "UNKNOWN"
            )

            reason_text = (
                status.get(
                    "errorReasonText"
                )
                or (
                    "Cloudflare Stream "
                    "processing failed."
                )
            )

            raise (
                CloudflareStreamProcessingError(
                    f"{reason_code}: "
                    f"{reason_text}"
                )
            )

        if ready_to_stream:
            playback = (
                video.get(
                    "playback"
                )
                or {}
            )

            if playback.get(
                "hls"
            ):
                return video

        if (
            time.monotonic()
            >= deadline
        ):
            return None

        time.sleep(
            STREAM_POLL_SECONDS
        )


# ============================================================
# SOURCE VIDEO FROM SUPABASE ROW
# ============================================================


def video_from_processing_row(
    row,
):
    """
    Rebuild the minimal source-video object from an existing
    Supabase processing row.
    """

    source_mp4 = row.get(
        "source_mp4"
    )

    if (
        not isinstance(
            source_mp4,
            str,
        )
        or not source_mp4
    ):
        raise RuntimeError(
            "Processing row has "
            "no source_mp4."
        )

    match = SOURCE_PATTERN.match(
        source_mp4
    )

    if not match:
        raise RuntimeError(
            "Invalid source_mp4 in "
            f"processing row: "
            f"{source_mp4}"
        )

    creator_handle = (
        row.get(
            "creator_handle"
        )
        or match.group(1)
    )

    video_number = (
        row.get(
            "video_number"
        )
    )

    if video_number is None:
        video_number = int(
            match.group(2)
        )

    file_size = (
        row.get(
            "file_size_bytes"
        )
        or 0
    )

    return {
        "key": source_mp4,
        "creator_handle": (
            creator_handle
        ),
        "video_number": int(
            video_number
        ),
        "size": int(
            file_size
        ),
    }


# ============================================================
# PROCESS STREAM VIDEO
# ============================================================


def process_stream_video(
    row,
    video,
):
    row_id = row["id"]

    source_key = video[
        "key"
    ]

    creator_handle = video[
        "creator_handle"
    ]

    video_number = video[
        "video_number"
    ]

    logger.info(
        "=" * 72
    )

    logger.info(
        "Creator: %s",
        creator_handle,
    )

    logger.info(
        "Source: %s",
        source_key,
    )

    logger.info(
        "Video number: %03d",
        video_number,
    )

    logger.info(
        "=" * 72
    )

    try:
        if not creator_exists(
            creator_handle
        ):
            raise RuntimeError(
                "Creator "
                f"'{creator_handle}' "
                "is not present in "
                "Supabase creators."
            )

        uid = acquire_stream_uid(
            row,
            video,
        )

        stream_video = (
            wait_for_stream_ready(
                uid
            )
        )

        if stream_video is None:
            mark_video_processing(
                row_id
            )

            logger.info(
                "STREAM STILL PROCESSING | "
                "source=%s | uid=%s",
                source_key,
                uid,
            )

            return False

        mark_video_ready(
            row_id,
            stream_video,
        )

        logger.info(
            "Video completed "
            "successfully."
        )

        return True

    except Exception as exc:
        logger.error(
            "PROCESSING ERROR | "
            "source=%s | %s",
            source_key,
            exc,
        )

        try:
            mark_video_failed(
                row_id,
                exc,
            )

        except Exception as db_exc:
            logger.error(
                "Could not write "
                "error state to "
                "Supabase: %s",
                db_exc,
            )

        raise


# ============================================================
# SELECT NEW PENDING SOURCE
# ============================================================


def select_pending_video():
    """
    Preserve the original production candidate behavior.

    All R2 source MP4s are passed through Selection Engine v1.
    Existing Supabase source_mp4 rows are skipped.

    The first genuinely new candidate is selected.
    """

    all_sources = (
        list_source_videos()
    )

    ordered = (
        order_candidates_for_selection(
            all_sources
        )
    )

    logger.info(
        "Source MP4 files found: %s",
        len(ordered),
    )

    for video in ordered:
        source_key = video[
            "key"
        ]

        existing = (
            video_exists_in_supabase(
                source_key
            )
        )

        if existing:
            continue

        if not creator_exists(
            video[
                "creator_handle"
            ]
        ):
            logger.warning(
                "Creator '%s' does not "
                "exist in Supabase. "
                "Skipping source %s.",
                video[
                    "creator_handle"
                ],
                source_key,
            )

            continue

        return video

    return None


# ============================================================
# PREFLIGHT
# ============================================================


def preflight():
    """
    Configuration validation only.

    No R2 mutation.
    No Supabase mutation.
    No Stream upload.
    """

    if (
        STREAM_POLL_SECONDS
        <= 0
    ):
        raise RuntimeError(
            "STREAM_POLL_SECONDS "
            "must be greater than 0."
        )

    if (
        STREAM_WAIT_SECONDS
        <= 0
    ):
        raise RuntimeError(
            "STREAM_WAIT_SECONDS "
            "must be greater than 0."
        )

    if (
        R2_PRESIGNED_URL_SECONDS
        <= 0
    ):
        raise RuntimeError(
            "R2_PRESIGNED_URL_SECONDS "
            "must be greater than 0."
        )

    logger.info(
        "Tikboo Worker"
    )

    logger.info(
        "Version: %s",
        WORKER_VERSION,
    )

    logger.info(
        "Bucket: %s",
        R2_BUCKET,
    )

    logger.info(
        "Architecture: "
        "R2 -> Stream -> Supabase"
    )


# ============================================================
# MAIN
# ============================================================


def main():
    preflight()

    # --------------------------------------------------------
    # STEP 1
    #
    # Resume an existing Stream processing row first.
    #
    # This prevents duplicate uploads and guarantees that an
    # interrupted video is completed before a new source is
    # selected.
    # --------------------------------------------------------

    processing_row = (
        get_processing_video()
    )

    if processing_row:
        logger.info(
            "Resuming existing "
            "processing row | "
            "id=%s | source=%s",
            processing_row.get(
                "id"
            ),
            processing_row.get(
                "source_mp4"
            ),
        )

        video = (
            video_from_processing_row(
                processing_row
            )
        )

        try:
            process_stream_video(
                processing_row,
                video,
            )

            return 0

        except Exception:
            logger.exception(
                "Worker stopped while "
                "resuming Stream video."
            )

            return 1

    # --------------------------------------------------------
    # STEP 2
    #
    # Select exactly one NEW source MP4.
    # --------------------------------------------------------

    video = select_pending_video()

    if not video:
        logger.info(
            "No pending source MP4 "
            "was found."
        )

        return 0

    # --------------------------------------------------------
    # STEP 3
    #
    # Defensive duplicate check immediately before INSERT.
    # --------------------------------------------------------

    existing = (
        video_exists_in_supabase(
            video["key"]
        )
    )

    if existing:
        logger.info(
            "Source already exists "
            "in Supabase. "
            "Skipping: %s",
            video["key"],
        )

        return 0

    # --------------------------------------------------------
    # STEP 4
    #
    # Create durable processing row BEFORE sending anything to
    # Cloudflare Stream.
    # --------------------------------------------------------

    row = insert_processing_row(
        video
    )

    logger.info(
        "Supabase processing row "
        "created | id=%s | "
        "source=%s",
        row["id"],
        video["key"],
    )

    # --------------------------------------------------------
    # STEP 5
    #
    # Source MP4 in R2
    #       ->
    # presigned URL
    #       ->
    # Cloudflare Stream
    #       ->
    # Stream HLS + thumbnail
    #       ->
    # Supabase
    #
    # ZERO FFmpeg.
    # ZERO HLS output written back to R2.
    # --------------------------------------------------------

    try:
        completed = (
            process_stream_video(
                row,
                video,
            )
        )

    except Exception:
        logger.exception(
            "Worker stopped after "
            "processing error."
        )

        return 1

    if completed:
        logger.info(
            "One video completed "
            "successfully."
        )

    else:
        logger.info(
            "One video remains in "
            "Cloudflare Stream "
            "processing state."
        )

    return 0


# ============================================================
# ENTRYPOINT
# ============================================================


if __name__ == "__main__":
    try:
        sys.exit(
            main()
        )

    except KeyboardInterrupt:
        logger.warning(
            "Worker interrupted."
        )

        sys.exit(
            130
        )

    except Exception:
        logger.exception(
            "Worker terminated with "
            "unhandled error."
        )

        sys.exit(
            1
        )
