#!/usr/bin/env python3
"""
Batch-test titles against a Python regex pattern - the same `re` engine
and semantics yt-dlp's own --match-filter `~=` operator uses (see
test-python-regex.py, which validates/previews a single pattern the same
way). No flags are forced (e.g. no automatic re.IGNORECASE): the pattern
is compiled exactly as the user wrote it, so a pattern using Python-only
constructs like an inline (?i) flag behaves identically here, in the
match-filter path, and in the settings-dialog preview - one canonical
regex, not a JS/Python-compatible subset.

Reads a JSON array of titles from stdin (single subprocess call for the
whole batch, not one per title) and writes {"matches": [bool, ...]} in
the same order, or {"error": "..."} if the pattern or input is invalid.
"""
import sys
import re
import json

def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "Usage: filter-titles-by-regex.py <pattern> (titles as JSON array on stdin)"}))
        sys.exit(1)

    pattern = sys.argv[1]
    try:
        regex = re.compile(pattern)
    except re.error as e:
        print(json.dumps({"error": f"Invalid regex pattern: {str(e)}"}))
        sys.exit(1)

    try:
        titles = json.loads(sys.stdin.read())
        if not isinstance(titles, list):
            raise ValueError("titles input must be a JSON array")
    except (json.JSONDecodeError, ValueError) as e:
        print(json.dumps({"error": f"Invalid titles input: {str(e)}"}))
        sys.exit(1)

    matches = [bool(regex.search(title or "")) for title in titles]
    print(json.dumps({"matches": matches}))

if __name__ == "__main__":
    main()
