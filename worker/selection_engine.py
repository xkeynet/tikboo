#!/usr/bin/env python3

from __future__ import annotations

import random
from typing import Any, Dict, List, Optional

from config import SELECTION_ENGINE_CODENAME, SELECTION_ENGINE_VERSION, SELECTION_HISTORY_LIMIT
from data_access import (
    creator_exists,
    get_video_by_source,
    list_source_videos,
    row_has_existing_playback,
    row_has_terminal_media_error,
    row_uses_cloudflare_stream,
    supabase_get,
)


# ============================================================
# TIKBOO SELECTION SYSTEM V2 — CONTROL
# ============================================================
#
# Core rule:
#
#   CREATOR FIRST -> VIDEO SECOND
#
# A creator with a large pending library must never monopolize
# consecutive worker runs merely because its videos start at 001.
#
# ============================================================


def get_recent_ready_creators() -> List[str]:
    try:
        rows = supabase_get(
            "videos",
            {
                "select": "creator_handle",
                "processing_status": "eq.ready",
                "order": "created_at.desc",
                "limit": str(SELECTION_HISTORY_LIMIT),
            },
        )
    except Exception as exc:
        print("Selection Engine: could not read creator history:", exc)
        return []

    return [
        str(row["creator_handle"])
        for row in rows
        if row.get("creator_handle")
    ]


def build_spread_order(videos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Spread selection across a creator's pending library instead
    of consuming videos linearly as 001, 002, 003, 004...

    Example:

        001 002 003 004 005 006 007

    becomes approximately:

        001 007 004 002 006 003 005
    """

    if len(videos) <= 2:
        return list(videos)

    ordered = sorted(videos, key=lambda item: item["video_number"])
    result: List[Dict[str, Any]] = []

    def spread(items: List[Dict[str, Any]]) -> None:
        if not items:
            return

        if len(items) == 1:
            result.append(items[0])
            return

        result.append(items[0])

        if len(items) > 1:
            result.append(items[-1])

        middle = items[1:-1]

        if not middle:
            return

        midpoint = len(middle) // 2
        result.append(middle[midpoint])

        remaining = middle[:midpoint] + middle[midpoint + 1:]

        if remaining:
            spread(remaining)

    spread(ordered)

    seen = set()
    unique: List[Dict[str, Any]] = []

    for video in result:
        key = video["key"]

        if key in seen:
            continue

        seen.add(key)
        unique.append(video)

    return unique


def candidate_from_source(video: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    source_key = video["key"]
    creator_handle = video["creator_handle"]

    if not creator_exists(creator_handle):
        return None

    existing_row = get_video_by_source(source_key)

    if existing_row is None:
        return {
            "video": video,
            "row": None,
            "existing_row": False,
        }

    if row_uses_cloudflare_stream(existing_row):
        return None

    existing_playback = row_has_existing_playback(existing_row)

    if (
        existing_row.get("processing_status") == "error"
        and not existing_playback
    ):
        return None

    if (
        existing_playback
        and row_has_terminal_media_error(existing_row)
    ):
        return None

    return {
        "video": video,
        "row": existing_row,
        "existing_row": existing_playback,
    }


def build_pending_by_creator(
    sources: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    source_groups: Dict[str, List[Dict[str, Any]]] = {}

    for video in sources:
        source_groups.setdefault(
            video["creator_handle"],
            [],
        ).append(video)

    pending: Dict[str, List[Dict[str, Any]]] = {}

    for creator_handle, creator_sources in source_groups.items():
        creator_candidates: List[Dict[str, Any]] = []

        for video in creator_sources:
            candidate = candidate_from_source(video)

            if candidate is not None:
                creator_candidates.append(candidate)

        if creator_candidates:
            pending[creator_handle] = build_spread_order(
                [candidate["video"] for candidate in creator_candidates]
            )

    return pending


def creator_priority(
    creator: str,
    recent_creators: List[str],
) -> tuple:
    """
    Creators used least recently receive priority.

    A creator absent from the recent history receives the
    strongest priority.
    """

    try:
        recent_position = recent_creators.index(creator)
    except ValueError:
        recent_position = SELECTION_HISTORY_LIMIT + 1

    recent_count = recent_creators.count(creator)

    return (
        recent_count,
        -recent_position,
        random.SystemRandom().random(),
    )


def select_pending_videos() -> List[Dict[str, Any]]:
    sources = list_source_videos()

    if not sources:
        print("Selection Engine: no source MP4 files found.")
        return []

    source_groups: Dict[str, List[Dict[str, Any]]] = {}

    for video in sources:
        source_groups.setdefault(
            video["creator_handle"],
            [],
        ).append(video)

    pending_by_creator: Dict[str, List[Dict[str, Any]]] = {}

    for creator_handle, creator_sources in source_groups.items():
        candidates: List[Dict[str, Any]] = []

        if not creator_exists(creator_handle):
            continue

        for video in creator_sources:
            candidate = candidate_from_source(video)

            if candidate is not None:
                candidates.append(candidate)

        if not candidates:
            continue

        video_map = {
            candidate["video"]["key"]: candidate
            for candidate in candidates
        }

        spread_videos = build_spread_order(
            [candidate["video"] for candidate in candidates]
        )

        pending_by_creator[creator_handle] = [
            video_map[video["key"]]
            for video in spread_videos
        ]

    if not pending_by_creator:
        print("Selection Engine: no actionable candidates.")
        return []

    recent_creators = get_recent_ready_creators()
    creators = list(pending_by_creator.keys())

    creators.sort(
        key=lambda creator: creator_priority(
            creator,
            recent_creators,
        )
    )

    ordered: List[Dict[str, Any]] = []

    while True:
        added = False

        for creator in creators:
            candidates = pending_by_creator[creator]

            if not candidates:
                continue

            ordered.append(candidates.pop(0))
            added = True

        if not added:
            break

    print()
    print(
        f"Selection System {SELECTION_ENGINE_VERSION} "
        f"— {SELECTION_ENGINE_CODENAME}"
    )
    print("Source MP4 files:", len(sources))
    print("Creators with pending video:", len(creators))
    print("Actionable candidates:", len(ordered))

    if recent_creators:
        print("Last ready creator:", recent_creators[0])

    if ordered:
        first = ordered[0]["video"]
        print(
            "Next selection:",
            f"{first['creator_handle']}/{first['video_number']:03d}",
        )

    return ordered
