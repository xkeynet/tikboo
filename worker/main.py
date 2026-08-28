#!/usr/bin/env python3

from __future__ import annotations

import sys

from config import (
    HTTP_TIMEOUT_SECONDS,
    PROCESS_OUTCOME_COMPLETED,
    PROCESS_OUTCOME_MEDIA_FAILED,
    PROCESS_OUTCOME_PROCESSING,
    R2_BUCKET,
    R2_PRESIGNED_URL_SECONDS,
    SELECTION_ENGINE_CODENAME,
    SELECTION_ENGINE_VERSION,
    STREAM_MEDIA_FRESH_RETRIES,
    STREAM_POLL_SECONDS,
    STREAM_WAIT_SECONDS,
    WORKER_VERSION,
)
from data_access import TikbooWorkerError
from media_pipeline import process_video
from selection_engine import select_pending_videos


# ============================================================
# TIKBOO VIDEO WORKER
# ============================================================
#
# main.py is intentionally only the orchestrator.
#
# config.py
#   Configuration / environment.
#
# data_access.py
#   R2 read-only access + Supabase persistence.
#
# media_pipeline.py
#   Cloudflare Stream processing / recovery / hardening.
#
# selection_engine.py
#   Tikboo Selection System V2 — Control.
#
# ============================================================


# ============================================================
# PREFLIGHT
# ============================================================

def preflight() -> None:
    if STREAM_POLL_SECONDS <= 0:
        raise TikbooWorkerError(
            "STREAM_POLL_SECONDS must be greater than 0."
        )

    if STREAM_WAIT_SECONDS <= 0:
        raise TikbooWorkerError(
            "STREAM_WAIT_SECONDS must be greater than 0."
        )

    if R2_PRESIGNED_URL_SECONDS <= 0:
        raise TikbooWorkerError(
            "R2_PRESIGNED_URL_SECONDS must be greater than 0."
        )

    if HTTP_TIMEOUT_SECONDS <= 0:
        raise TikbooWorkerError(
            "HTTP_TIMEOUT_SECONDS must be greater than 0."
        )

    if STREAM_MEDIA_FRESH_RETRIES < 0:
        raise TikbooWorkerError(
            "STREAM_MEDIA_FRESH_RETRIES must be 0 or greater."
        )

    print("Tikboo Worker")
    print(f"Version: {WORKER_VERSION}")
    print(
        f"Selection System: "
        f"{SELECTION_ENGINE_VERSION} — "
        f"{SELECTION_ENGINE_CODENAME}"
    )
    print(f"R2 bucket: {R2_BUCKET}")
    print("Fresh media retries:", STREAM_MEDIA_FRESH_RETRIES)
    print()
    print("Pipeline:")
    print("R2 original MP4")
    print(" -> Hetzner orchestration")
    print(" -> Cloudflare Stream")
    print(" -> Supabase")
    print()
    print("R2 HLS writes:      DISABLED")
    print("R2 poster writes:   DISABLED")
    print("R2 source deletion: DISABLED")


# ============================================================
# MAIN
# ============================================================

def main() -> int:
    preflight()

    candidates = select_pending_videos()

    if not candidates:
        print()
        print(
            "No source video requires "
            "Cloudflare Stream processing."
        )
        return 0

    terminal_media_failures = 0

    for selected in candidates:
        video = selected["video"]
        row = selected["row"]
        existing_row = bool(selected["existing_row"])

        outcome = process_video(
            video=video,
            row=row,
            existing_row=existing_row,
        )

        if outcome == PROCESS_OUTCOME_COMPLETED:
            print()
            print("One video completed successfully.")

            if terminal_media_failures:
                print(
                    "Terminal media failures skipped earlier this run:",
                    terminal_media_failures,
                )

            return 0

        if outcome == PROCESS_OUTCOME_PROCESSING:
            print()
            print(
                "One video remains in "
                "Cloudflare Stream processing."
            )

            if terminal_media_failures:
                print(
                    "Terminal media failures skipped earlier this run:",
                    terminal_media_failures,
                )

            return 0

        if outcome == PROCESS_OUTCOME_MEDIA_FAILED:
            terminal_media_failures += 1

            print()
            print(
                "Continuing to next "
                "Selection Engine candidate."
            )
            continue

        raise TikbooWorkerError(
            f"Unknown process_video outcome: {outcome}"
        )

    print()

    if terminal_media_failures:
        print("No video completed successfully.")
        print(
            "All actionable candidates reached "
            "terminal media failure or no further "
            "candidate remained."
        )
        print(
            "Terminal media failures this run:",
            terminal_media_failures,
        )
    else:
        print("No actionable candidate was completed.")

    return 0


# ============================================================
# ENTRYPOINT
# ============================================================

if __name__ == "__main__":
    try:
        sys.exit(main())

    except KeyboardInterrupt:
        print()
        print("Worker interrupted.")
        sys.exit(130)

    except Exception as exc:
        print()
        print("Unhandled worker error:")
        print(exc)
        sys.exit(1)
