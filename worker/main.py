#!/usr/bin/env python3

from __future__ import annotations

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
# Cloudflare R2
#   Source storage ONLY.
#
#   creators/<creator_handle>/001.mp4
#   creators/<creator_handle>/002.mp4
#   creators/<creator_handle>/003.mp4
#
# Hetzner
#   Automation / orchestration:
#
#   - discovers source MP4 files in R2
#   - preserves creator/video selection logic
#   - cooperates with Supabase
#   - creates temporary signed GET URL for source MP4
#   - sends that URL to Cloudflare Stream
#   - waits for Stream processing
#   - writes final playback metadata to Supabase
#
# Cloudflare Stream
#   Final video processing and delivery:
#
#   - fetches source MP4
#   - transcodes video
#   - creates HLS
#   - creates DASH
#   - creates thumbnail
#   - serves playback
#
# Supabase
#   Processing state + Tikboo playback metadata.
#
#
# ABSOLUTE R2 RULES
#
# This worker NEVER:
#
#   - deletes source MP4
#   - modifies source MP4
#   - creates index.m3u8 in R2
#   - creates segment_*.ts in R2
#   - creates segment_*.m4s in R2
#   - creates init.mp4 in R2
#   - creates poster.webp in R2
#   - uploads playback output to R2
#
# There is intentionally NO:
#
#   s3.upload_file(...)
#   s3.put_object(...)
#   s3.delete_object(...)
#
# R2 is read-only from the worker's point of view,
# except for normal LIST/GET/presigned GET operations.
#
# ============================================================


# ============================================================
# VERSION
# ============================================================

WORKER_VERSION = "stream-3.1.0"


# ============================================================
# PATHS / ENVIRONMENT
# ============================================================

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"

load_dotenv(ENV_FILE)


# ============================================================
# R2 ENVIRONMENT
# ============================================================

R2_ENDPOINT = os.environ["R2_ENDPOINT"]
R2_ACCESS_KEY = os.environ["R2_ACCESS_KEY"]
R2_SECRET_KEY = os.environ["R2_SECRET_KEY"]
R2_BUCKET = os.environ["R2_BUCKET"]


# ============================================================
# SUPABASE ENVIRONMENT
# ============================================================

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]


# ============================================================
# CLOUDFLARE STREAM ENVIRONMENT
# ============================================================

CLOUDFLARE_ACCOUNT_ID = os.environ["CLOUDFLARE_ACCOUNT_ID"]

CLOUDFLARE_STREAM_API_TOKEN = os.environ[
    "CLOUDFLARE_STREAM_API_TOKEN"
]


# ============================================================
# OPTIONAL SETTINGS
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

HTTP_TIMEOUT_SECONDS = int(
    os.getenv(
        "HTTP_TIMEOUT_SECONDS",
        "60",
    )
)


# ============================================================
# CONSTANTS
# ============================================================

CREATORS_PREFIX = "creators/"

CLOUDFLARE_API_BASE = (
    "https://api.cloudflare.com/client/v4"
)

SOURCE_PATTERN = re.compile(
    r"^creators/([^/]+)/(\d+)\.mp4$",
    re.IGNORECASE,
)

STREAM_UID_MARKER_PREFIX = "cfstream://"

STREAM_UID_FROM_URL_PATTERN = re.compile(
    r"(?:cloudflarestream\.com|videodelivery\.net)"
    r"/([A-Za-z0-9_-]{10,64})/",
    re.IGNORECASE,
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

class TikbooWorkerError(RuntimeError):
    pass


class CloudflareStreamError(TikbooWorkerError):
    pass


class CloudflareStreamProcessingError(
    CloudflareStreamError
):
    pass


# ============================================================
# GENERIC HELPERS
# ============================================================

def now_iso() -> str:
    return datetime.now(
        timezone.utc
    ).isoformat()


def truncate_error(
    value: Any,
    limit: int = 4000,
) -> str:
    text = str(value)

    if len(text) <= limit:
        return text

    return text[:limit]


def duration_to_int(
    value: Any,
) -> Optional[int]:
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
# SUPABASE HEADERS
# ============================================================

def supabase_headers(
    prefer: Optional[str] = None,
) -> Dict[str, str]:

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


# ============================================================
# SUPABASE GENERIC GET
# ============================================================

def supabase_get(
    table: str,
    params: Dict[str, Any],
) -> List[Dict[str, Any]]:

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
        raise TikbooWorkerError(
            "Unexpected Supabase response "
            f"for table '{table}'."
        )

    return rows


# ============================================================
# SUPABASE GENERIC INSERT
# ============================================================

def supabase_insert(
    table: str,
    payload: Dict[str, Any],
) -> Dict[str, Any]:

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
        raise TikbooWorkerError(
            "Supabase did not return "
            f"inserted '{table}' row."
        )

    return rows[0]


# ============================================================
# SUPABASE GENERIC PATCH
# ============================================================

def supabase_patch(
    table: str,
    params: Dict[str, Any],
    payload: Dict[str, Any],
) -> None:

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
# SOURCE MP4 DISCOVERY
# ============================================================

def list_source_videos() -> List[
    Dict[str, Any]
]:
    """
    Read ONLY original source MP4 objects.

    ACCEPTED:

        creators/abbyy.irl/001.mp4
        creators/abbyy.irl/002.mp4
        creators/creator/100.mp4

    IGNORED:

        creators/abbyy.irl/001/index.m3u8
        creators/abbyy.irl/001/poster.webp
        creators/abbyy.irl/001/init.mp4
        creators/abbyy.irl/001/segment_00001.m4s
        creators/abbyy.irl/001/segment_00001.ts

    The worker only LISTS objects here.
    """

    paginator = s3.get_paginator(
        "list_objects_v2"
    )

    videos: List[
        Dict[str, Any]
    ] = []

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

def order_candidates_for_selection(
    videos: List[
        Dict[str, Any]
    ],
) -> List[
    Dict[str, Any]
]:
    """
    Preserve existing Tikboo Selection Engine v1.

    - creators randomized
    - latest ready creator is avoided
      when alternatives exist
    - numeric video order inside creator
    - candidates interleaved across creators
    - one worker execution processes
      maximum one selected video
    """

    if not videos:
        return []

    by_creator: Dict[
        str,
        List[Dict[str, Any]],
    ] = {}

    for video in videos:
        creator_handle = (
            video[
                "creator_handle"
            ]
        )

        by_creator.setdefault(
            creator_handle,
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
        rows = supabase_get(
            "videos",
            {
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
        )

        if rows:
            last_creator = (
                rows[0].get(
                    "creator_handle"
                )
            )

    except Exception as exc:
        print(
            "Selection Engine: "
            "could not read last creator:",
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

    ordered: List[
        Dict[str, Any]
    ] = []

    while True:
        added = False

        for creator in creators:
            creator_videos = (
                by_creator[
                    creator
                ]
            )

            if not creator_videos:
                continue

            ordered.append(
                creator_videos.pop(
                    0
                )
            )

            added = True

        if not added:
            break

    print(
        "Selection Engine v1:",
        f"{len(creators)} creators,",
        f"{len(ordered)} source candidates.",
    )

    if last_creator:
        print(
            "Last ready creator:",
            last_creator,
        )

    return ordered


# ============================================================
# CREATOR LOOKUP
# ============================================================

def creator_exists(
    handle: str,
) -> bool:

    rows = supabase_get(
        "creators",
        {
            "select": "id,handle",
            "handle": (
                f"eq.{handle}"
            ),
            "limit": "1",
        },
    )

    return bool(rows)


# ============================================================
# VIDEO LOOKUP
# ============================================================

def get_video_by_source(
    source_mp4: str,
) -> Optional[
    Dict[str, Any]
]:

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

    if not rows:
        return None

    return rows[0]


# ============================================================
# STREAM UID EXTRACTION
# ============================================================

def extract_stream_uid_from_value(
    value: Any,
) -> Optional[str]:

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
        STREAM_UID_FROM_URL_PATTERN.search(
            value
        )
    )

    if not match:
        return None

    return match.group(1)


def extract_stream_uid_from_row(
    row: Dict[str, Any],
) -> Optional[str]:

    for column in (
        "video_url",
        "manifest_url",
        "hls_url",
        "poster_url",
    ):
        uid = (
            extract_stream_uid_from_value(
                row.get(column)
            )
        )

        if uid:
            return uid

    return None


# ============================================================
# CHECK WHETHER ROW ALREADY USES STREAM
# ============================================================

def row_uses_cloudflare_stream(
    row: Dict[str, Any],
) -> bool:

    uid = extract_stream_uid_from_row(
        row
    )

    if not uid:
        return False

    return (
        row.get(
            "processing_status"
        )
        == "ready"
        and row.get(
            "hls_ready"
        )
        is True
    )


# ============================================================
# INSERT NEW PROCESSING ROW
# ============================================================

def insert_processing_row(
    video: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Uses only columns already present in the
    existing production worker/schema.
    """

    payload = {
        "creator_handle": (
            video[
                "creator_handle"
            ]
        ),
        "video_url": None,
        "video_number": (
            video[
                "video_number"
            ]
        ),
        "source_mp4": (
            video[
                "key"
            ]
        ),
        "file_size_bytes": (
            video[
                "size"
            ]
        ),
        "is_active": False,
        "created_by_worker": True,
        "processing_status": (
            "processing"
        ),
        "hls_ready": False,
        "worker_version": (
            WORKER_VERSION
        ),
        "error_message": None,
    }

    return supabase_insert(
        "videos",
        payload,
    )


# ============================================================
# SAVE STREAM UID DURING PROCESSING
# ============================================================

def save_stream_uid(
    row_id: Any,
    stream_uid: str,
    preserve_existing_playback: bool,
) -> None:
    """
    For NEW rows:
        temporarily stores cfstream://UID
        in video_url.

    For EXISTING R2 rows:
        does NOT overwrite working playback
        while Stream is still encoding.

    Existing rows can recover the UID via
    Stream meta.name search if worker restarts.
    """

    payload: Dict[
        str,
        Any,
    ] = {
        "worker_version": (
            WORKER_VERSION
        ),
        "last_processed_at": (
            now_iso()
        ),
        "error_message": None,
    }

    if not preserve_existing_playback:
        payload.update(
            {
                "video_url": (
                    STREAM_UID_MARKER_PREFIX
                    + stream_uid
                ),
                "processing_status": (
                    "processing"
                ),
                "hls_ready": False,
                "is_active": False,
            }
        )

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
# KEEP NEW ROW IN PROCESSING STATE
# ============================================================

def mark_new_row_processing(
    row_id: Any,
) -> None:

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


# ============================================================
# MARK VIDEO READY
# ============================================================

def mark_video_ready(
    row_id: Any,
    stream_video: Dict[str, Any],
) -> None:

    uid = stream_video.get(
        "uid"
    )

    if not uid:
        raise CloudflareStreamError(
            "Cloudflare Stream ready "
            "response contains no UID."
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
        "hls_url": (
            hls_url
        ),
        "poster_url": (
            poster_url
        ),
        "duration_seconds": (
            duration_seconds
        ),
        "processing_status": (
            "ready"
        ),
        "hls_ready": True,
        "is_active": True,
        "created_by_worker": True,
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

    print()
    print(
        "Supabase READY"
    )
    print(
        f"Row ID:     {row_id}"
    )
    print(
        f"Stream UID: {uid}"
    )
    print(
        f"HLS:        {hls_url}"
    )
    print(
        f"Poster:     {poster_url}"
    )
    print(
        f"Duration:   {duration_seconds}"
    )


# ============================================================
# MARK NEW VIDEO FAILED
# ============================================================

def mark_new_video_failed(
    row_id: Any,
    error_message: Any,
) -> None:

    supabase_patch(
        "videos",
        {
            "id": (
                f"eq.{row_id}"
            ),
        },
        {
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
        },
    )


# ============================================================
# RECORD MIGRATION ERROR
# ============================================================

def mark_existing_migration_error(
    row_id: Any,
    error_message: Any,
) -> None:
    """
    Existing R2 playback is deliberately preserved.

    If Stream migration fails, this function
    does NOT alter:

        video_url
        manifest_url
        hls_url
        poster_url
        processing_status
        hls_ready
        is_active

    It only records diagnostics.
    """

    supabase_patch(
        "videos",
        {
            "id": (
                f"eq.{row_id}"
            ),
        },
        {
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
        },
    )


# ============================================================
# R2 PRESIGNED SOURCE URL
# ============================================================

def create_presigned_source_url(
    source_key: str,
) -> str:
    """
    Creates temporary READ-ONLY GET URL.

    No R2 object is changed.
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
# CLOUDFLARE HEADERS
# ============================================================

def cloudflare_headers() -> Dict[
    str,
    str,
]:

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


# ============================================================
# CLOUDFLARE REQUEST
# ============================================================

def cloudflare_request(
    method: str,
    path: str,
    params: Optional[
        Dict[str, Any]
    ] = None,
    json_body: Optional[
        Dict[str, Any]
    ] = None,
) -> Dict[str, Any]:

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
            "non-JSON response. "
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
            "Cloudflare API request failed: "
            f"{payload.get('errors')}"
        )

    return payload


# ============================================================
# FIND STREAM VIDEO BY SOURCE
# ============================================================

def find_stream_video_by_source(
    source_mp4: str,
) -> Optional[
    Dict[str, Any]
]:
    """
    Duplicate protection.

    Every Stream video created by this worker gets:

        meta.name = creators/<handle>/<number>.mp4

    Cloudflare Stream search is used to recover
    an upload after a Hetzner restart.

    Exact meta.name is checked after search.
    """

    response = cloudflare_request(
        "GET",
        (
            f"/accounts/"
            f"{CLOUDFLARE_ACCOUNT_ID}"
            "/stream"
        ),
        params={
            "search": source_mp4,
        },
    )

    result = response.get(
        "result"
    )

    if not isinstance(
        result,
        list,
    ):
        return None

    matches: List[
        Dict[str, Any]
    ] = []

    for item in result:
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

        if not isinstance(
            meta,
            dict,
        ):
            continue

        if (
            meta.get("name")
            != source_mp4
        ):
            continue

        uid = item.get(
            "uid"
        )

        if not uid:
            continue

        matches.append(
            item
        )

    if not matches:
        return None

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

    print()
    print(
        "Recovered existing "
        "Cloudflare Stream object:"
    )
    print(
        f"Source: {source_mp4}"
    )
    print(
        f"UID:    {selected['uid']}"
    )

    return selected


# ============================================================
# CREATE STREAM VIDEO FROM R2 SOURCE
# ============================================================

def create_stream_video(
    video: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Cloudflare Stream fetches the source MP4
    directly from a temporary signed R2 URL.

    Hetzner does NOT download the source MP4.
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

    print()
    print(
        "Cloudflare Stream ingest"
    )
    print(
        f"Source: {source_key}"
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
            "Cloudflare Stream /copy "
            "returned no result object."
        )

    uid = result.get(
        "uid"
    )

    if not uid:
        raise CloudflareStreamError(
            "Cloudflare Stream /copy "
            "returned no UID."
        )

    print(
        "Stream accepted video"
    )
    print(
        f"UID: {uid}"
    )

    return result


# ============================================================
# GET STREAM VIDEO DETAILS
# ============================================================

def get_stream_video(
    uid: str,
) -> Dict[str, Any]:

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
            "Cloudflare Stream returned "
            "no video details for UID "
            f"{uid}."
        )

    return result


# ============================================================
# ACQUIRE STREAM UID
# ============================================================

def acquire_stream_uid(
    row: Dict[str, Any],
    video: Dict[str, Any],
    preserve_existing_playback: bool,
) -> str:
    """
    Idempotency order:

    1. UID already present in Supabase
    2. Existing Stream video by exact source name
    3. New Stream /copy request

    This prevents duplicate Stream videos after
    normal worker restarts.
    """

    source_key = video[
        "key"
    ]

    existing_uid = (
        extract_stream_uid_from_row(
            row
        )
    )

    if existing_uid:
        print()
        print(
            "Resuming Stream UID "
            "from Supabase:"
        )
        print(
            f"UID: {existing_uid}"
        )

        return existing_uid

    recovered = (
        find_stream_video_by_source(
            source_key
        )
    )

    if recovered:
        uid = recovered.get(
            "uid"
        )

        if uid:
            save_stream_uid(
                row["id"],
                uid,
                preserve_existing_playback,
            )

            return uid

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
            "contains no UID."
        )

    save_stream_uid(
        row["id"],
        uid,
        preserve_existing_playback,
    )

    return uid


# ============================================================
# WAIT FOR STREAM
# ============================================================

def wait_for_stream_ready(
    uid: str,
) -> Optional[
    Dict[str, Any]
]:
    """
    Poll until Cloudflare Stream reports:

        readyToStream == true

    If the configured wait window expires while
    Cloudflare is still processing, return None.

    The next worker run resumes the same Stream
    object instead of creating another one.
    """

    deadline = (
        time.monotonic()
        + STREAM_WAIT_SECONDS
    )

    while True:
        stream_video = (
            get_stream_video(
                uid
            )
        )

        status = (
            stream_video.get(
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
            stream_video.get(
                "readyToStream"
            )
            is True
        )

        print(
            "Stream status:",
            f"UID={uid}",
            f"state={state}",
            f"progress={pct_complete}",
            f"ready={ready_to_stream}",
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
                stream_video.get(
                    "playback"
                )
                or {}
            )

            if playback.get(
                "hls"
            ):
                return stream_video

        if (
            time.monotonic()
            >= deadline
        ):
            return None

        time.sleep(
            STREAM_POLL_SECONDS
        )


# ============================================================
# SELECT SOURCE THAT STILL NEEDS STREAM
# ============================================================

def select_pending_video() -> Optional[
    Dict[str, Any]
]:
    """
    Existing Tikboo videos are migrated IN PLACE.

    Cases:

    1. No Supabase row:
       -> create new processing row.

    2. Existing Supabase row with old R2 playback:
       -> reuse that row.
       -> preserve old playback while Stream processes.
       -> replace playback only after Stream is ready.

    3. Existing ready Cloudflare Stream row:
       -> skip.

    No duplicate Supabase row is created for an
    existing source_mp4.
    """

    all_sources = (
        list_source_videos()
    )

    ordered = (
        order_candidates_for_selection(
            all_sources
        )
    )

    print(
        "Original MP4 files found:",
        len(ordered),
    )

    for video in ordered:
        source_key = video[
            "key"
        ]

        creator_handle = video[
            "creator_handle"
        ]

        if not creator_exists(
            creator_handle
        ):
            print(
                "Skipping source: "
                "creator missing in Supabase:"
            )
            print(
                source_key
            )

            continue

        existing_row = (
            get_video_by_source(
                source_key
            )
        )

        if existing_row:
            if row_uses_cloudflare_stream(
                existing_row
            ):
                continue

            return {
                "video": video,
                "row": existing_row,
                "existing_row": True,
            }

        return {
            "video": video,
            "row": None,
            "existing_row": False,
        }

    return None


# ============================================================
# PROCESS ONE VIDEO
# ============================================================

def process_video(
    video: Dict[str, Any],
    row: Optional[
        Dict[str, Any]
    ],
    existing_row: bool,
) -> bool:

    source_key = video[
        "key"
    ]

    creator_handle = video[
        "creator_handle"
    ]

    video_number = video[
        "video_number"
    ]

    print()
    print(
        "=" * 72
    )
    print(
        "TIKBOO CLOUDFLARE STREAM WORKER"
    )
    print(
        "=" * 72
    )
    print(
        f"Creator: {creator_handle}"
    )
    print(
        f"Source:  {source_key}"
    )
    print(
        f"Video:   {video_number:03d}"
    )

    if existing_row:
        print(
            "Mode:    migrate existing "
            "Supabase row"
        )
    else:
        print(
            "Mode:    new source video"
        )

    print(
        "=" * 72
    )

    if not creator_exists(
        creator_handle
    ):
        raise TikbooWorkerError(
            "Creator "
            f"'{creator_handle}' "
            "does not exist in "
            "Supabase creators."
        )

    if row is None:
        row = insert_processing_row(
            video
        )

        print()
        print(
            "Supabase processing row created"
        )
        print(
            f"Row ID: {row['id']}"
        )

    row_id = row[
        "id"
    ]

    try:
        uid = acquire_stream_uid(
            row,
            video,
            preserve_existing_playback=(
                existing_row
            ),
        )

        stream_video = (
            wait_for_stream_ready(
                uid
            )
        )

        if stream_video is None:
            print()
            print(
                "Cloudflare Stream is "
                "still processing."
            )

            if not existing_row:
                mark_new_row_processing(
                    row_id
                )

            print(
                "Worker will resume the "
                "same Stream object later."
            )

            return False

        mark_video_ready(
            row_id,
            stream_video,
        )

        print()
        print(
            "Video completed successfully."
        )

        return True

    except Exception as exc:
        print()
        print(
            "PROCESSING ERROR:"
        )
        print(
            exc
        )

        try:
            if existing_row:
                mark_existing_migration_error(
                    row_id,
                    exc,
                )

            else:
                mark_new_video_failed(
                    row_id,
                    exc,
                )

        except Exception as db_exc:
            print()
            print(
                "Could not save error "
                "state to Supabase:"
            )
            print(
                db_exc
            )

        raise


# ============================================================
# PREFLIGHT
# ============================================================

def preflight() -> None:
    """
    Validate configuration.

    No R2 mutation.
    No Supabase mutation.
    No Stream upload.
    """

    required_values = {
        "R2_ENDPOINT": (
            R2_ENDPOINT
        ),
        "R2_ACCESS_KEY": (
            R2_ACCESS_KEY
        ),
        "R2_SECRET_KEY": (
            R2_SECRET_KEY
        ),
        "R2_BUCKET": (
            R2_BUCKET
        ),
        "SUPABASE_URL": (
            SUPABASE_URL
        ),
        "SUPABASE_KEY": (
            SUPABASE_KEY
        ),
        "CLOUDFLARE_ACCOUNT_ID": (
            CLOUDFLARE_ACCOUNT_ID
        ),
        "CLOUDFLARE_STREAM_API_TOKEN": (
            CLOUDFLARE_STREAM_API_TOKEN
        ),
    }

    for name, value in (
        required_values.items()
    ):
        if not value:
            raise TikbooWorkerError(
                f"{name} is empty."
            )

    if (
        STREAM_POLL_SECONDS
        <= 0
    ):
        raise TikbooWorkerError(
            "STREAM_POLL_SECONDS "
            "must be greater than 0."
        )

    if (
        STREAM_WAIT_SECONDS
        <= 0
    ):
        raise TikbooWorkerError(
            "STREAM_WAIT_SECONDS "
            "must be greater than 0."
        )

    if (
        R2_PRESIGNED_URL_SECONDS
        <= 0
    ):
        raise TikbooWorkerError(
            "R2_PRESIGNED_URL_SECONDS "
            "must be greater than 0."
        )

    if (
        HTTP_TIMEOUT_SECONDS
        <= 0
    ):
        raise TikbooWorkerError(
            "HTTP_TIMEOUT_SECONDS "
            "must be greater than 0."
        )

    print(
        "Tikboo Worker"
    )
    print(
        f"Version: {WORKER_VERSION}"
    )
    print(
        f"R2 bucket: {R2_BUCKET}"
    )
    print()
    print(
        "Pipeline:"
    )
    print(
        "R2 original MP4"
    )
    print(
        " -> Hetzner orchestration"
    )
    print(
        " -> Cloudflare Stream"
    )
    print(
        " -> Supabase"
    )
    print()
    print(
        "R2 HLS writes:      DISABLED"
    )
    print(
        "R2 poster writes:   DISABLED"
    )
    print(
        "R2 source deletion: DISABLED"
    )


# ============================================================
# MAIN
# ============================================================

def main() -> int:

    preflight()

    selected = (
        select_pending_video()
    )

    if not selected:
        print()
        print(
            "No source video requires "
            "Cloudflare Stream processing."
        )

        return 0

    video = selected[
        "video"
    ]

    row = selected[
        "row"
    ]

    existing_row = bool(
        selected[
            "existing_row"
        ]
    )

    try:
        completed = (
            process_video(
                video=video,
                row=row,
                existing_row=existing_row,
            )
        )

    except Exception:
        print()
        print(
            "Worker stopped after "
            "processing error."
        )

        return 1

    if completed:
        print()
        print(
            "One video completed "
            "successfully."
        )

    else:
        print()
        print(
            "One video remains in "
            "Cloudflare Stream "
            "processing."
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
        print()
        print(
            "Worker interrupted."
        )

        sys.exit(
            130
        )

    except Exception as exc:
        print()
        print(
            "Unhandled worker error:"
        )
        print(
            exc
        )

        sys.exit(
            1
        )
