"""Sliding-window rate limiting for sign-in, invite and device activation endpoints.

Counters live in this process's memory: with several workers each keeps its own
count, so the effective limit is (limit x workers). Put a shared limiter (reverse
proxy or Redis) in front for strict multi-worker limits.
"""
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import HTTPException, Request, status

_windows: Dict[str, Deque[float]] = defaultdict(deque)


def client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def hit(bucket: str, key: str, limit: int, window_seconds: int, message: str = "Too many attempts. Try again later.") -> None:
    """Counts one attempt for (bucket, key); raises 429 once `limit` is reached inside the window."""
    now = time.monotonic()
    window = _windows[f"{bucket}|{key}"]
    while window and now - window[0] > window_seconds:
        window.popleft()
    if len(window) >= limit:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=message)
    window.append(now)


def check(bucket: str, key: str, limit: int, window_seconds: int, message: str = "Too many attempts. Try again later.") -> None:
    """Raises 429 if `limit` attempts were already recorded in the window, without counting this one."""
    now = time.monotonic()
    window = _windows[f"{bucket}|{key}"]
    while window and now - window[0] > window_seconds:
        window.popleft()
    if len(window) >= limit:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=message)


def record(bucket: str, key: str) -> None:
    """Counts one attempt (e.g. a failure) for (bucket, key)."""
    _windows[f"{bucket}|{key}"].append(time.monotonic())


def reset() -> None:
    """Clears every counter (tests)."""
    _windows.clear()
