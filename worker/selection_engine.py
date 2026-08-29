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
# TIKBOO SELECTION SYSTEM V2.1 — CONTROL
# ============================================================
#
# Core rules:
#
#   CREATOR FIRST -> VIDEO SECOND
#
#   Creator selection:
#   - least recently used creator wins
#   - creator absent from recent history gets priority
#   - after one successful selection, that creator immediately
#     becomes recent and moves behind untouched creators
#   - NO historical-count "catch-up", therefore a new creator
#     cannot be drained repeatedly
#
#   Video selection:
#   - stable spread is built from the creator's ENTIRE R2 library
#   - only afterwards are READY / ERROR / completed sources removed
#   - sequence therefore remains distributed across the library
#     instead of restarting from the smallest pending number
#
# ============================================================


# ============================================================
# RECENT CREATOR HISTORY
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


# ============================================================
# STABLE VIDEO SPREAD
# ============================================================

def build_spread_order(videos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Build a deterministic spread over the ENTIRE creator library.

    Example:

        001 002 003 004 005 006 007 008 009

    becomes approximately:

        001 009 005 002 004 003 006 008 007

    Important:
    this function must receive ALL source videos for the creator,
    not only currently pending videos. That makes the order stable
    between worker runs.
    """

    if not videos:
        return []

    ordered = sorted(videos, key=lambda item: item["video_number"])

    if len(ordered) <= 2:
        return ordered

    result: List[Dict[str, Any]] = []
    seen = set()

    def add(video: Dict[str, Any]) -> None:
        key = video["key"]

        if key in seen:
            return

        seen.add(key)
        result.append(video)

    def spread(items: List[Dict[str, Any]]) -> None:
        if not items:
            return

        if len(items) == 1:
            add(items[0])
            return

        add(items[0])
        add(items[-1])

        middle = items[1:-1]

        if not middle:
            return

        midpoint = len(middle) // 2
        add(middle[midpoint])

        left = middle[:midpoint]
        right = middle[midpoint + 1:]

        if left:
            spread(left)

        if right:
            spread(right)

    spread(ordered)

    return result


# ============================================================
# SOURCE ELIGIBILITY
# ============================================================

def candidate_from_source(video: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Determine whether one R2 source still requires processing.

    Creator existence is deliberately NOT checked here.
    It is checked once per creator, not once per source video.
    """

    source_key = video["key"]
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


# ============================================================
# CREATOR PRIORITY — TRUE LRU FAIRNESS
# ============================================================

def creator_priority(
    creator: str,
    recent_creators: List[str],
    randomizer: random.SystemRandom,
) -> tuple:
    """
    True least-recently-used creator scheduling.

    IMPORTANT:
    We DO NOT compare how many times a creator appears in the
    history window. That old behaviour caused a newly added
    creator to be selected repeatedly until it "caught up"
    with older creators.

    Instead:

    1. Creator absent from recent history:
       highest priority.

    2. Creator already present:
       the creator whose latest occurrence is oldest wins.

    Once a new creator succeeds once, it becomes the most recent
    creator and immediately moves behind creators that have not
    yet received a turn.
    """

    try:
        position = recent_creators.index(creator)
    except ValueError:
        return (
            0,
            randomizer.random(),
        )

    return (
        1,
        -position,
        randomizer.random(),
    )


# ============================================================
# BUILD CREATOR SOURCE POOL
# ============================================================

def group_sources_by_creator(
    sources: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:

    grouped: Dict[str, List[Dict[str, Any]]] = {}

    for video in sources:
        grouped.setdefault(
            video["creator_handle"],
            [],
        ).append(video)

    for creator_sources in grouped.values():
        creator_sources.sort(
            key=lambda item: item["video_number"]
        )

    return grouped


# ============================================================
# FIND ACTIONABLE SOURCES FOR ONE CREATOR
# ============================================================

def build_creator_candidates(
    creator_handle: str,
    creator_sources: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Spread the FULL source library first.

    Only after the stable spread exists do we remove sources that
    are already READY, terminal ERROR, or otherwise completed.

    This preserves a real cross-library progression between runs.
    """

    if not creator_exists(creator_handle):
        print(
            "Selection Engine: skipping creator missing in Supabase:",
            creator_handle,
        )
        return []

    spread_sources = build_spread_order(creator_sources)
    candidates: List[Dict[str, Any]] = []

    for video in spread_sources:
        candidate = candidate_from_source(video)

        if candidate is not None:
            candidates.append(candidate)

    return candidates


# ============================================================
# SELECTION ENGINE
# ============================================================

def select_pending_videos() -> List[Dict[str, Any]]:
    sources = list_source_videos()

    if not sources:
        print("Selection Engine: no source MP4 files found.")
        return []

    source_groups = group_sources_by_creator(sources)
    recent_creators = get_recent_ready_creators()
    randomizer = random.SystemRandom()

    creators = list(source_groups.keys())

    creators.sort(
        key=lambda creator: creator_priority(
            creator,
            recent_creators,
            randomizer,
        )
    )

    pending_by_creator: Dict[str, List[Dict[str, Any]]] = {}

    for creator_handle in creators:
        candidates = build_creator_candidates(
            creator_handle,
            source_groups[creator_handle],
        )

        if candidates:
            pending_by_creator[creator_handle] = candidates

    actionable_creators = [
        creator
        for creator in creators
        if creator in pending_by_creator
    ]

    if not actionable_creators:
        print("Selection Engine: no actionable candidates.")
        return []

    ordered: List[Dict[str, Any]] = []

    while True:
        added = False

        for creator in actionable_creators:
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
        f"— {SELECTION_ENGINE_CODENAME} / V2.1"
    )
    print("Source MP4 files:", len(sources))
    print("R2 creators discovered:", len(source_groups))
    print("Creators with actionable video:", len(actionable_creators))
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
