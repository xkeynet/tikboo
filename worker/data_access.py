#!/usr/bin/env python3

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import boto3
import requests
from botocore.config import Config as BotoConfig

from config import (
    CREATORS_PREFIX,
    HTTP_TIMEOUT_SECONDS,
    MEDIA_TERMINAL_ERROR_PREFIX,
    R2_ACCESS_KEY,
    R2_BUCKET,
    R2_ENDPOINT,
    R2_PRESIGNED_URL_SECONDS,
    R2_SECRET_KEY,
    SOURCE_PATTERN,
    STREAM_UID_FROM_URL_PATTERN,
    STREAM_UID_MARKER_PREFIX,
    SUPABASE_KEY,
    SUPABASE_URL,
    WORKER_VERSION,
)


# ============================================================
# TIKBOO WORKER — DATA ACCESS
# ============================================================
#
# Responsibilities:
#
# - Cloudflare R2 source discovery
# - READ-ONLY R2 presigned GET URLs
# - Supabase REST access
# - creator lookup
# - video row lookup
# - processing / ready / failure state persistence
#
# ABSOLUTE R2 RULE:
#
# This module NEVER uploads, modifies or deletes R2 objects.
#
# ============================================================


# ============================================================
# EXCEPTIONS
# ============================================================

class TikbooWorkerError(RuntimeError):
    pass


# ============================================================
# HTTP SESSION
# ============================================================

http = requests.Session()
http.headers.update({"User-Agent": f"TikbooWorker/{WORKER_VERSION}"})


# ============================================================
# R2 CLIENT — READ ONLY
# ============================================================

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY,
    aws_secret_access_key=R2_SECRET_KEY,
    region_name="auto",
    config=BotoConfig(
        signature_version="s3v4",
        retries={"max_attempts": 5, "mode": "standard"},
    ),
)


# ============================================================
# GENERIC HELPERS
# ============================================================

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def truncate_error(value: Any, limit: int = 4000) -> str:
    text = str(value)
    return text if len(text) <= limit else text[:limit]


def duration_to_int(value: Any) -> Optional[int]:
    if value is None:
        return None

    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None

    if duration < 0:
        return None

    return int(round(duration))


# ============================================================
# SUPABASE
# ============================================================

def supabase_headers(prefer: Optional[str] = None) -> Dict[str, str]:
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    if prefer:
        headers["Prefer"] = prefer

    return headers


def supabase_get(table: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    response = http.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers(),
        params=params,
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    rows = response.json()

    if not isinstance(rows, list):
        raise TikbooWorkerError(
            f"Unexpected Supabase response for table '{table}'."
        )

    return rows


def supabase_insert(table: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    response = http.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers("return=representation"),
        json=payload,
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    rows = response.json()

    if not isinstance(rows, list) or not rows:
        raise TikbooWorkerError(
            f"Supabase did not return inserted '{table}' row."
        )

    return rows[0]


def supabase_patch(
    table: str,
    params: Dict[str, Any],
    payload: Dict[str, Any],
) -> None:
    response = http.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers("return=minimal"),
        params=params,
        json=payload,
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    response.raise_for_status()


# ============================================================
# R2 SOURCE DISCOVERY
# ============================================================

def list_source_videos() -> List[Dict[str, Any]]:
    """
    Return only original source MP4 files matching:

        creators/<creator_handle>/<number>.mp4

    R2 remains completely read-only.
    """

    paginator = s3.get_paginator("list_objects_v2")
    videos: List[Dict[str, Any]] = []

    for page in paginator.paginate(
        Bucket=R2_BUCKET,
        Prefix=CREATORS_PREFIX,
    ):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            match = SOURCE_PATTERN.match(key)

            if not match:
                continue

            videos.append(
                {
                    "key": key,
                    "creator_handle": match.group(1),
                    "video_number": int(match.group(2)),
                    "size": int(obj.get("Size", 0)),
                }
            )

    videos.sort(
        key=lambda item: (
            item["creator_handle"].lower(),
            item["video_number"],
        )
    )

    return videos


def create_presigned_source_url(source_key: str) -> str:
    """
    Create temporary READ-ONLY GET URL.

    No R2 object is changed.
    """

    return s3.generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": R2_BUCKET, "Key": source_key},
        ExpiresIn=R2_PRESIGNED_URL_SECONDS,
        HttpMethod="GET",
    )


# ============================================================
# CREATOR LOOKUP
# ============================================================

def creator_exists(handle: str) -> bool:
    rows = supabase_get(
        "creators",
        {
            "select": "id,handle",
            "handle": f"eq.{handle}",
            "limit": "1",
        },
    )

    return bool(rows)


# ============================================================
# STREAM UID EXTRACTION
# ============================================================

def extract_stream_uid_from_value(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None

    value = value.strip()

    if not value:
        return None

    if value.startswith(STREAM_UID_MARKER_PREFIX):
        uid = value[len(STREAM_UID_MARKER_PREFIX):].strip()
        return uid or None

    match = STREAM_UID_FROM_URL_PATTERN.search(value)
    return match.group(1) if match else None


def extract_stream_uid_from_row(row: Dict[str, Any]) -> Optional[str]:
    for column in (
        "video_url",
        "manifest_url",
        "hls_url",
        "poster_url",
    ):
        uid = extract_stream_uid_from_value(row.get(column))

        if uid:
            return uid

    return None


# ============================================================
# VIDEO ROW CLASSIFICATION
# ============================================================

def row_uses_cloudflare_stream(row: Dict[str, Any]) -> bool:
    return (
        extract_stream_uid_from_row(row) is not None
        and row.get("processing_status") == "ready"
        and row.get("hls_ready") is True
    )


def row_has_existing_playback(row: Dict[str, Any]) -> bool:
    """
    Detect an existing ready non-Stream playback row.

    Such playback must remain untouched until a
    Cloudflare Stream migration is fully ready.
    """

    if row_uses_cloudflare_stream(row):
        return False

    if row.get("processing_status") != "ready":
        return False

    if row.get("hls_ready") is not True:
        return False

    for column in ("video_url", "manifest_url", "hls_url"):
        value = row.get(column)

        if isinstance(value, str) and value.strip():
            return True

    return False


def row_has_terminal_media_error(row: Dict[str, Any]) -> bool:
    error_message = row.get("error_message")

    return (
        isinstance(error_message, str)
        and error_message.startswith(MEDIA_TERMINAL_ERROR_PREFIX)
    )


# ============================================================
# VIDEO LOOKUP
# ============================================================

def get_video_by_source(source_mp4: str) -> Optional[Dict[str, Any]]:
    rows = supabase_get(
        "videos",
        {
            "select": "*",
            "source_mp4": f"eq.{source_mp4}",
            "order": "id.desc",
        },
    )

    if not rows:
        return None

    stream_rows = [
        row for row in rows
        if row_uses_cloudflare_stream(row)
    ]

    if stream_rows:
        if len(rows) > 1:
            print(
                f"Duplicate Supabase rows detected for {source_mp4}: "
                f"{len(rows)} rows. Existing ready Stream row wins."
            )

        return stream_rows[0]

    legacy_rows = [
        row for row in rows
        if row_has_existing_playback(row)
    ]

    if legacy_rows:
        if len(rows) > 1:
            print(
                f"Duplicate Supabase rows detected for {source_mp4}: "
                f"{len(rows)} rows. Existing ready legacy playback row wins."
            )

        return legacy_rows[0]

    if len(rows) > 1:
        print(
            f"Duplicate Supabase rows detected for {source_mp4}: "
            f"{len(rows)} rows. Using newest row ID {rows[0].get('id')}."
        )

    return rows[0]


# ============================================================
# PROCESSING ROW
# ============================================================

def insert_processing_row(video: Dict[str, Any]) -> Dict[str, Any]:
    payload = {
        "creator_handle": video["creator_handle"],
        "video_url": None,
        "video_number": video["video_number"],
        "source_mp4": video["key"],
        "file_size_bytes": video["size"],
        "is_active": False,
        "created_by_worker": True,
        "processing_status": "processing",
        "hls_ready": False,
        "worker_version": WORKER_VERSION,
        "error_message": None,
    }

    return supabase_insert("videos", payload)


def save_stream_uid(
    row_id: Any,
    stream_uid: str,
    preserve_existing_playback: bool,
) -> None:
    payload: Dict[str, Any] = {
        "worker_version": WORKER_VERSION,
        "last_processed_at": now_iso(),
        "error_message": None,
    }

    if not preserve_existing_playback:
        payload.update(
            {
                "video_url": STREAM_UID_MARKER_PREFIX + stream_uid,
                "processing_status": "processing",
                "hls_ready": False,
                "is_active": False,
            }
        )

    supabase_patch(
        "videos",
        {"id": f"eq.{row_id}"},
        payload,
    )


def mark_new_row_processing(row_id: Any) -> None:
    supabase_patch(
        "videos",
        {"id": f"eq.{row_id}"},
        {
            "processing_status": "processing",
            "hls_ready": False,
            "is_active": False,
            "worker_version": WORKER_VERSION,
            "last_processed_at": now_iso(),
            "error_message": None,
        },
    )


# ============================================================
# READY STATE
# ============================================================

def mark_video_ready(
    row_id: Any,
    stream_video: Dict[str, Any],
) -> None:
    uid = stream_video.get("uid")

    if not uid:
        raise TikbooWorkerError(
            "Cloudflare Stream ready response contains no UID."
        )

    playback = stream_video.get("playback") or {}
    hls_url = playback.get("hls")

    if not hls_url:
        raise TikbooWorkerError(
            f"Cloudflare Stream video {uid} is ready but playback.hls is missing."
        )

    poster_url = stream_video.get("thumbnail")

    if not poster_url:
        raise TikbooWorkerError(
            f"Cloudflare Stream video {uid} is ready but thumbnail is missing."
        )

    duration_seconds = duration_to_int(
        stream_video.get("duration")
    )

    payload = {
        "video_url": hls_url,
        "manifest_url": hls_url,
        "hls_url": hls_url,
        "poster_url": poster_url,
        "duration_seconds": duration_seconds,
        "processing_status": "ready",
        "hls_ready": True,
        "is_active": True,
        "created_by_worker": True,
        "worker_version": WORKER_VERSION,
        "last_processed_at": now_iso(),
        "error_message": None,
    }

    supabase_patch(
        "videos",
        {"id": f"eq.{row_id}"},
        payload,
    )

    print()
    print("Supabase READY")
    print(f"Row ID:     {row_id}")
    print(f"Stream UID: {uid}")
    print(f"HLS:        {hls_url}")
    print(f"Poster:     {poster_url}")
    print(f"Duration:   {duration_seconds}")


# ============================================================
# FAILURE STATE
# ============================================================

def mark_new_video_failed(
    row_id: Any,
    error_message: Any,
) -> None:
    supabase_patch(
        "videos",
        {"id": f"eq.{row_id}"},
        {
            "processing_status": "error",
            "hls_ready": False,
            "is_active": False,
            "worker_version": WORKER_VERSION,
            "last_processed_at": now_iso(),
            "error_message": truncate_error(error_message),
        },
    )


def mark_existing_migration_error(
    row_id: Any,
    error_message: Any,
) -> None:
    """
    Existing playback remains untouched.

    Only diagnostics are updated.
    """

    supabase_patch(
        "videos",
        {"id": f"eq.{row_id}"},
        {
            "worker_version": WORKER_VERSION,
            "last_processed_at": now_iso(),
            "error_message": truncate_error(error_message),
        },
    )
