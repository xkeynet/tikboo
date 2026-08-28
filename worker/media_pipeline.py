#!/usr/bin/env python3

from __future__ import annotations

import time
from typing import Any, Dict, Optional

import requests

from config import (
    CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_BASE,
    CLOUDFLARE_STREAM_API_TOKEN,
    HTTP_TIMEOUT_SECONDS,
    MEDIA_TERMINAL_ERROR_PREFIX,
    PROCESS_OUTCOME_COMPLETED,
    PROCESS_OUTCOME_MEDIA_FAILED,
    PROCESS_OUTCOME_PROCESSING,
    STREAM_MEDIA_FRESH_RETRIES,
    STREAM_POLL_SECONDS,
    STREAM_WAIT_SECONDS,
    WORKER_VERSION,
)
from data_access import (
    TikbooWorkerError,
    create_presigned_source_url,
    creator_exists,
    extract_stream_uid_from_row,
    insert_processing_row,
    mark_existing_migration_error,
    mark_new_row_processing,
    mark_new_video_failed,
    mark_video_ready,
    save_stream_uid,
)


# ============================================================
# TIKBOO WORKER — MEDIA PIPELINE
# ============================================================

http = requests.Session()
http.headers.update({"User-Agent": f"TikbooWorker/{WORKER_VERSION}"})


# ============================================================
# EXCEPTIONS
# ============================================================

class CloudflareStreamError(TikbooWorkerError):
    pass


class CloudflareStreamProcessingError(CloudflareStreamError):
    pass


# ============================================================
# STREAM STATE
# ============================================================

def get_stream_state(stream_video: Dict[str, Any]) -> Optional[str]:
    status = stream_video.get("status") or {}

    if not isinstance(status, dict):
        return None

    state = status.get("state")
    return str(state).lower() if state is not None else None


def stream_video_is_error(stream_video: Dict[str, Any]) -> bool:
    return get_stream_state(stream_video) == "error"


def build_stream_processing_error(
    stream_video: Dict[str, Any],
) -> CloudflareStreamProcessingError:
    uid = stream_video.get("uid")
    status = stream_video.get("status") or {}

    if not isinstance(status, dict):
        status = {}

    reason_code = status.get("errorReasonCode") or "ERR_UNKNOWN"
    reason_text = (
        status.get("errorReasonText")
        or "Cloudflare Stream processing failed."
    )

    prefix = f"UID {uid}: " if uid else ""

    return CloudflareStreamProcessingError(
        f"{prefix}{reason_code}: {reason_text}"
    )


def build_terminal_media_error(
    source_key: str,
    error: Exception,
    fresh_retries_used: int,
) -> str:
    return (
        f"{MEDIA_TERMINAL_ERROR_PREFIX} "
        f"source={source_key}; "
        f"fresh_retries={fresh_retries_used}; "
        f"{error}"
    )


# ============================================================
# CLOUDFLARE API
# ============================================================

def cloudflare_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {CLOUDFLARE_STREAM_API_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def cloudflare_request(
    method: str,
    path: str,
    params: Optional[Dict[str, Any]] = None,
    json_body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    response = http.request(
        method=method,
        url=CLOUDFLARE_API_BASE + path,
        headers=cloudflare_headers(),
        params=params,
        json=json_body,
        timeout=HTTP_TIMEOUT_SECONDS,
    )

    try:
        payload = response.json()
    except ValueError as exc:
        raise CloudflareStreamError(
            f"Cloudflare returned non-JSON response. "
            f"HTTP {response.status_code}: {response.text}"
        ) from exc

    if not response.ok:
        raise CloudflareStreamError(
            f"Cloudflare API HTTP {response.status_code}: {payload}"
        )

    if payload.get("success") is not True:
        raise CloudflareStreamError(
            f"Cloudflare API request failed: {payload.get('errors')}"
        )

    return payload


# ============================================================
# STREAM LOOKUP / RECOVERY
# ============================================================

def find_stream_video_by_source(
    source_mp4: str,
) -> Optional[Dict[str, Any]]:
    response = cloudflare_request(
        "GET",
        f"/accounts/{CLOUDFLARE_ACCOUNT_ID}/stream",
        params={"search": source_mp4},
    )

    result = response.get("result")

    if not isinstance(result, list):
        return None

    matches = []
    rejected_error_objects = 0

    for item in result:
        if not isinstance(item, dict):
            continue

        meta = item.get("meta") or {}

        if not isinstance(meta, dict):
            continue

        if meta.get("name") != source_mp4:
            continue

        uid = item.get("uid")

        if not uid:
            continue

        if stream_video_is_error(item):
            rejected_error_objects += 1

            print()
            print("Ignoring failed Cloudflare Stream object:")
            print(f"Source: {source_mp4}")
            print(f"UID:    {uid}")
            continue

        matches.append(item)

    if rejected_error_objects:
        print("Failed Stream objects ignored:", rejected_error_objects)

    if not matches:
        return None

    matches.sort(
        key=lambda item: (
            str(item.get("created") or ""),
            str(item.get("uid") or ""),
        ),
        reverse=True,
    )

    selected = matches[0]

    print()
    print("Recovered existing Cloudflare Stream object:")
    print(f"Source: {source_mp4}")
    print(f"UID:    {selected['uid']}")
    print("Recovery policy: newest non-error match")

    return selected


# ============================================================
# STREAM INGEST
# ============================================================

def create_stream_video(video: Dict[str, Any]) -> Dict[str, Any]:
    source_key = video["key"]
    source_url = create_presigned_source_url(source_key)

    payload = {
        "url": source_url,
        "meta": {
            "name": source_key,
            "source_mp4": source_key,
            "creator_handle": video["creator_handle"],
            "video_number": str(video["video_number"]),
            "worker_version": WORKER_VERSION,
        },
    }

    print()
    print("Cloudflare Stream ingest")
    print(f"Source: {source_key}")

    response = cloudflare_request(
        "POST",
        f"/accounts/{CLOUDFLARE_ACCOUNT_ID}/stream/copy",
        json_body=payload,
    )

    result = response.get("result")

    if not isinstance(result, dict):
        raise CloudflareStreamError(
            "Cloudflare Stream /copy returned no result object."
        )

    uid = result.get("uid")

    if not uid:
        raise CloudflareStreamError(
            "Cloudflare Stream /copy returned no UID."
        )

    print("Stream accepted video")
    print(f"UID: {uid}")

    return result


def get_stream_video(uid: str) -> Dict[str, Any]:
    response = cloudflare_request(
        "GET",
        f"/accounts/{CLOUDFLARE_ACCOUNT_ID}/stream/{uid}",
    )

    result = response.get("result")

    if not isinstance(result, dict):
        raise CloudflareStreamError(
            f"Cloudflare Stream returned no video details for UID {uid}."
        )

    return result


def validate_resumed_stream_uid(uid: str) -> None:
    stream_video = get_stream_video(uid)

    if stream_video_is_error(stream_video):
        raise build_stream_processing_error(stream_video)


# ============================================================
# STREAM UID ACQUISITION
# ============================================================

def acquire_stream_uid(
    row: Dict[str, Any],
    video: Dict[str, Any],
    preserve_existing_playback: bool,
) -> str:
    source_key = video["key"]
    existing_uid = extract_stream_uid_from_row(row)

    if existing_uid:
        print()
        print("Resuming Stream UID from Supabase:")
        print(f"UID: {existing_uid}")

        validate_resumed_stream_uid(existing_uid)
        return existing_uid

    recovered = find_stream_video_by_source(source_key)

    if recovered:
        uid = recovered.get("uid")

        if uid:
            save_stream_uid(
                row["id"],
                uid,
                preserve_existing_playback,
            )
            return uid

    created = create_stream_video(video)
    uid = created.get("uid")

    if not uid:
        raise CloudflareStreamError(
            "Created Stream video contains no UID."
        )

    save_stream_uid(
        row["id"],
        uid,
        preserve_existing_playback,
    )

    return uid


def create_fresh_retry_stream_uid(
    row_id: Any,
    video: Dict[str, Any],
    preserve_existing_playback: bool,
) -> str:
    created = create_stream_video(video)
    uid = created.get("uid")

    if not uid:
        raise CloudflareStreamError(
            "Fresh retry Stream video contains no UID."
        )

    save_stream_uid(
        row_id,
        uid,
        preserve_existing_playback,
    )

    return uid


# ============================================================
# STREAM POLLING
# ============================================================

def wait_for_stream_ready(
    uid: str,
) -> Optional[Dict[str, Any]]:
    deadline = time.monotonic() + STREAM_WAIT_SECONDS

    while True:
        stream_video = get_stream_video(uid)
        status = stream_video.get("status") or {}

        if not isinstance(status, dict):
            status = {}

        state = status.get("state")
        pct_complete = status.get("pctComplete")
        ready_to_stream = stream_video.get("readyToStream") is True

        print(
            "Stream status:",
            f"UID={uid}",
            f"state={state}",
            f"progress={pct_complete}",
            f"ready={ready_to_stream}",
        )

        if stream_video_is_error(stream_video):
            raise build_stream_processing_error(stream_video)

        if ready_to_stream:
            playback = stream_video.get("playback") or {}

            if playback.get("hls"):
                return stream_video

        if time.monotonic() >= deadline:
            return None

        time.sleep(STREAM_POLL_SECONDS)


# ============================================================
# PROCESS ONE VIDEO
# ============================================================

def process_video(
    video: Dict[str, Any],
    row: Optional[Dict[str, Any]],
    existing_row: bool,
) -> str:
    source_key = video["key"]
    creator_handle = video["creator_handle"]
    video_number = video["video_number"]

    print()
    print("=" * 72)
    print("TIKBOO CLOUDFLARE STREAM WORKER")
    print("=" * 72)
    print(f"Creator: {creator_handle}")
    print(f"Source:  {source_key}")
    print(f"Video:   {video_number:03d}")
    print(
        "Mode:    migrate existing Supabase playback row"
        if existing_row
        else "Mode:    new source video"
    )
    print("Fresh media retries:", STREAM_MEDIA_FRESH_RETRIES)
    print("=" * 72)

    if not creator_exists(creator_handle):
        raise TikbooWorkerError(
            f"Creator '{creator_handle}' does not exist in Supabase creators."
        )

    if row is None:
        row = insert_processing_row(video)

        print()
        print("Supabase processing row created")
        print(f"Row ID: {row['id']}")

    row_id = row["id"]
    fresh_retries_used = 0
    use_fresh_retry = False

    while True:
        try:
            if use_fresh_retry:
                print()
                print("Starting controlled fresh Cloudflare Stream retry.")
                print(
                    "Retry:",
                    f"{fresh_retries_used}/{STREAM_MEDIA_FRESH_RETRIES}",
                )

                uid = create_fresh_retry_stream_uid(
                    row_id,
                    video,
                    preserve_existing_playback=existing_row,
                )

            else:
                uid = acquire_stream_uid(
                    row,
                    video,
                    preserve_existing_playback=existing_row,
                )

            stream_video = wait_for_stream_ready(uid)

            if stream_video is None:
                print()
                print("Cloudflare Stream is still processing.")

                if not existing_row:
                    mark_new_row_processing(row_id)

                print("Worker will resume the same Stream object later.")
                return PROCESS_OUTCOME_PROCESSING

            mark_video_ready(row_id, stream_video)

            print()
            print("Video completed successfully.")

            return PROCESS_OUTCOME_COMPLETED

        except CloudflareStreamProcessingError as exc:
            print()
            print("MEDIA PROCESSING FAILURE:")
            print(exc)

            if fresh_retries_used < STREAM_MEDIA_FRESH_RETRIES:
                fresh_retries_used += 1
                use_fresh_retry = True

                print()
                print("Failed Stream object will NOT be recovered.")
                print("Scheduling fresh retry inside the same worker run:")
                print(
                    f"{fresh_retries_used}/{STREAM_MEDIA_FRESH_RETRIES}"
                )
                continue

            terminal_error = build_terminal_media_error(
                source_key,
                exc,
                fresh_retries_used,
            )

            print()
            print("TERMINAL MEDIA FAILURE:")
            print(terminal_error)

            if existing_row:
                mark_existing_migration_error(
                    row_id,
                    terminal_error,
                )

                print()
                print("Original playback preserved.")

            else:
                mark_new_video_failed(
                    row_id,
                    terminal_error,
                )

                print()
                print("Supabase row marked:")
                print("processing_status=error")
                print("hls_ready=false")
                print("is_active=false")

            print()
            print("Media failure isolated.")
            print("Worker may continue with the next candidate.")

            return PROCESS_OUTCOME_MEDIA_FAILED
