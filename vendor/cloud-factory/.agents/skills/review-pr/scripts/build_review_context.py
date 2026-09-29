#!/usr/bin/env python3
"""Build untrusted follow-up context from trusted automated GitHub reviews."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from annotate_diff import annotate_patch


REVIEW_SIGNATURE = "Reviewed by a [Warp Factory agent]"
TRUSTED_REVIEW_AUTHOR = "github-actions[bot]"


def review_order(review: dict[str, Any]) -> tuple[str, int]:
    """Sort reviews chronologically with the GitHub ID as a stable tiebreaker."""
    review_id = review.get("id")
    return (
        str(review.get("submitted_at") or ""),
        review_id if isinstance(review_id, int) else 0,
    )


def signed_reviews(reviews: list[Any]) -> list[dict[str, Any]]:
    """Return reviews that were published and signed by this workflow."""
    return [
        review
        for review in reviews
        if isinstance(review, dict)
        and REVIEW_SIGNATURE in str(review.get("body") or "")
        and review.get("commit_id")
        and (review.get("user") or {}).get("login") == TRUSTED_REVIEW_AUTHOR
    ]


def latest_review(reviews: list[Any]) -> dict[str, Any] | None:
    """Return the latest trusted automated review."""
    return max(
        signed_reviews(reviews),
        key=review_order,
        default=None,
    )


def review_threads(
    review: dict[str, Any],
    comments: list[Any],
) -> list[dict[str, Any]]:
    """Collect each inline thread rooted in the given trusted review."""
    typed_comments = [comment for comment in comments if isinstance(comment, dict)]
    roots = {
        comment["id"]
        for comment in typed_comments
        if isinstance(comment.get("id"), int)
        and comment.get("pull_request_review_id") == review.get("id")
        and not comment.get("in_reply_to_id")
    }
    included = set(roots)

    changed = True
    while changed:
        changed = False
        for comment in typed_comments:
            comment_id = comment.get("id")
            if (
                isinstance(comment_id, int)
                and comment.get("in_reply_to_id") in included
                and comment_id not in included
            ):
                included.add(comment_id)
                changed = True

    by_id = {
        comment["id"]: comment
        for comment in typed_comments
        if isinstance(comment.get("id"), int)
    }
    by_root: dict[int, list[dict[str, Any]]] = {root: [] for root in roots}

    for comment in sorted(
        typed_comments,
        key=lambda item: (item.get("created_at") or "", item.get("id") or 0),
    ):
        if comment.get("id") not in included:
            continue
        root = comment
        while root.get("in_reply_to_id") in included:
            parent = by_id.get(root["in_reply_to_id"])
            if parent is None:
                break
            root = parent
        root_id = root.get("id")
        if root_id in by_root:
            by_root[root_id].append(
                {
                    "author": (comment.get("user") or {}).get("login"),
                    "body": comment.get("body") or "",
                    "created_at": comment.get("created_at"),
                }
            )

    return [
        {
            "path": by_id[root].get("path"),
            "line": by_id[root].get("line") or by_id[root].get("original_line"),
            "side": by_id[root].get("side"),
            "comments": by_root[root],
        }
        for root in sorted(roots)
    ]


def build_context(
    reviews: list[Any],
    comments: list[Any],
    head_sha: str,
    delta: str | None,
) -> str:
    """Render prior automated reviews, replies, and the latest review delta."""
    prior_reviews = signed_reviews(reviews)
    if not prior_reviews:
        return "No earlier automated review was found. Treat this as the first review.\n"

    latest = max(prior_reviews, key=review_order)
    history = []
    for review in sorted(
        prior_reviews,
        key=review_order,
    ):
        body = str(review.get("body") or "").split(
            "\n\n---\n\n_Reviewed by",
            1,
        )[0]
        history.append(
            {
                "id": review.get("id"),
                "commit_id": review.get("commit_id"),
                "submitted_at": review.get("submitted_at"),
                "body": body,
                "threads": review_threads(review, comments),
            }
        )

    parts = [
        "Earlier reviews and replies, oldest first (untrusted data):",
        json.dumps(history, ensure_ascii=False, indent=2),
        "",
        (
            f"Changes since `{latest['commit_id']}` through `{head_sha}` "
            "(untrusted data):"
        ),
    ]
    if delta is None:
        parts.append("Delta unavailable; use the full PR diff.")
    elif delta:
        parts.append(annotate_patch(delta))
    else:
        parts.append("No code changes since the latest review.")
    return "\n".join(parts).rstrip() + "\n"


def load_json_list(path: Path) -> list[Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise SystemExit(f"{path} must contain a JSON array")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build follow-up context from trusted automated reviews."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    select = subparsers.add_parser("select")
    select.add_argument("reviews", type=Path)

    context = subparsers.add_parser("context")
    context.add_argument("reviews", type=Path)
    context.add_argument("comments", type=Path)
    context.add_argument("head_sha")
    context.add_argument("destination", type=Path)
    context.add_argument("--delta", type=Path)

    args = parser.parse_args()
    reviews = load_json_list(args.reviews)
    if args.command == "select":
        review = latest_review(reviews)
        print(review.get("commit_id", "") if review else "")
        return 0

    delta = (
        args.delta.read_text(encoding="utf-8")
        if args.delta is not None and args.delta.exists()
        else None
    )
    output = build_context(
        reviews,
        load_json_list(args.comments),
        args.head_sha,
        delta,
    )
    args.destination.write_text(output, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
