#!/usr/bin/env python3
"""
Decode season/episode numbers from a video title using a channel's custom
Python regex (TV Series library mode's optional "Season/Episode Decoding"
override - see channelSettingsModule.js's validateSeasonEpisodeRegex /
decodeSeasonEpisode). The pattern must define two named groups,
(?P<season>...) and (?P<episode>...), whose captured text must parse as
integers.

Mirrors test-python-regex.py's invocation contract (argv: pattern, title ->
JSON on stdout) so the same execFileSync-based call pattern in Node works
for both validating the pattern and decoding a real/preview title.
"""
import sys
import re
import json

REQUIRED_GROUPS = {'season', 'episode'}


def decode(pattern, title):
    try:
        regex = re.compile(pattern)
    except re.error as e:
        raise ValueError(f"Invalid regex pattern: {str(e)}")

    missing = REQUIRED_GROUPS - set(regex.groupindex.keys())
    if missing:
        raise ValueError(
            "Pattern must define named group(s): " + ", ".join(sorted(missing)) +
            " (e.g. (?P<season>\\d+) ... (?P<episode>\\d+))"
        )

    match = regex.search(title)
    if not match:
        return {"matches": False, "season": None, "episode": None}

    season_str = match.group('season')
    episode_str = match.group('episode')
    # A named group can match nothing if it's inside an unmatched
    # alternation branch - treat that as "no decode" for this title rather
    # than an error, same as a plain non-match.
    if season_str is None or episode_str is None:
        return {"matches": False, "season": None, "episode": None}

    try:
        season = int(season_str)
        episode = int(episode_str)
    except ValueError:
        raise ValueError(
            "Captured season/episode must be numeric (got season=%r, episode=%r)"
            % (season_str, episode_str)
        )

    # The matched span (e.g. "Season 21, Episode 10") is redundant once it's
    # been decoded into numbers - composeEpisodeFileTemplate already puts
    # "S21E10" at the front of the filename on its own, so leaving the
    # spelled-out (or even short-form) version in the title too just wastes
    # the title's 64-char truncation budget (real symptom: "Full Episode"
    # getting cut to "Full E") and, worse, duplicates "S21E10" in the
    # filename since the template's own prefix already supplies it. Drop the
    # matched span entirely, then collapse any doubled-up whitespace or
    # dangling " - " left behind by the removal.
    cleaned_title = title[:match.start()] + title[match.end():]
    cleaned_title = re.sub(r'\s*-\s*-\s*', ' - ', cleaned_title)
    cleaned_title = re.sub(r'\s{2,}', ' ', cleaned_title)
    cleaned_title = re.sub(r'^\s*-\s*|\s*-\s*$', '', cleaned_title).strip()

    return {
        "matches": True,
        "season": season,
        "episode": episode,
        "cleanedTitle": cleaned_title,
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({"error": "Usage: decode-season-episode.py <pattern> <title>"}))
        sys.exit(1)

    pattern = sys.argv[1]
    title = sys.argv[2]

    try:
        result = decode(pattern, title)
        print(json.dumps(result))
    except ValueError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
