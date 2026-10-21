"""Wrap a blocking callable so a test fails if it runs on an event loop.

Database reads, thread locks and graph compiles belong in AnyIO workers: on the
server loop they would stall every other request and stream (ARE-148).
"""

import asyncio
from functools import wraps


def worker_only(function):
    @wraps(function)
    def run(*args, **kwargs):
        try:
            asyncio.get_running_loop()
        except RuntimeError:  # a worker thread has none
            return function(*args, **kwargs)
        raise AssertionError(f"{function.__name__} ran on the event loop")

    return run
