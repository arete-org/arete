"""Require a Linear identifier on a pull request so Linear links it on its own."""

import os
import re
import sys

# Not the tail of a longer word such as `SHARE-1`.
LINEAR_ID = re.compile(r"(?<![A-Z0-9])ARE-[0-9]+", re.IGNORECASE)
# Automation opens these: no person can name a ticket for them.
EXEMPT_AUTHORS = frozenset({"dependabot[bot]", "renovate[bot]"})
EXEMPT_BRANCH_PREFIXES = ("dependabot/", "renovate/", "openwiki/update")
FAILURE = (
    "No Linear identifier (ARE-<n>) in the branch name or the PR body: "
    "rename the branch with Linear's suggested name or add ARE-<n> to the body, "
    "then re-run this job."
)


def is_exempt(branch: str, author: str) -> bool:
    return author in EXEMPT_AUTHORS or branch.startswith(EXEMPT_BRANCH_PREFIXES)


def has_linear_reference(branch: str, body: str) -> bool:
    # Linear's suggested branch names carry it lowercase: `name/are-124-title`.
    return bool(LINEAR_ID.search(branch) or LINEAR_ID.search(body))


def check(branch: str, author: str, body: str) -> str | None:
    """Return the failure message, or None when the PR passes."""
    if is_exempt(branch, author) or has_linear_reference(branch, body):
        return None
    return FAILURE


def main() -> int:
    failure = check(
        os.environ["BRANCH"], os.environ.get("AUTHOR", ""), os.environ.get("BODY", "")
    )
    if failure:
        # A workflow command makes the message the job's visible annotation.
        print(f"::error::{failure}")
        return 1
    print("Linear identifier found or PR exempt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
