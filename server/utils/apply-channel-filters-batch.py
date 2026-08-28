#!/usr/bin/env python3
"""
Batched version of test-python-regex.py + decode-season-episode.py combined:
tests a channel's title-filter regex and decodes its season/episode regex
against MANY video titles in a single process invocation, instead of one
python3 spawn per video. See channelSettingsModule.js's
testChannelFiltersBatch for the caller - used wherever a page of videos
needs a "would this pass the channel's Download Filters?" preview
(ChannelVideos.tsx's filter-bar toggle, and the Channel Settings dialog's
previews), since spawning a full Python interpreter per video (previously
up to one per row, e.g. 128 for a full page) dominated request latency far
more than the actual regex evaluation ever did.

Input (stdin): JSON object
  {
    "titleFilterRegex": "<pattern>" | "",
    "seasonEpisodeRegex": "<pattern>" | "",
    "videos": [{"id": "<any string>", "title": "<title>"}, ...]
  }

Output (stdout): JSON object, one of:
  {"error": "<message>"}                          - pattern itself invalid
  {"results": [{"id", "titleMatches", "seasonEpisodeMatches",
                "season", "episode", "cleanedTitle"}, ...]}

A blank titleFilterRegex means "every title matches" (same as the channel
having no title filter configured at all). A blank seasonEpisodeRegex
means every video reports seasonEpisodeMatches=false (caller falls back to
the upload-year-as-season default, same as decode-season-episode.py's
contract) - season/episode/cleanedTitle stay null in that case, exactly as
they do for a title that the pattern doesn't match.
"""
import sys
import re
import json

REQUIRED_GROUPS = {'season', 'episode'}


def compile_pattern(pattern, label):
    """Returns (compiled_regex_or_None, error_message_or_None)."""
    if not pattern:
        return None, None
    try:
        return re.compile(pattern), None
    except re.error as e:
        return None, f"Invalid {label} regex pattern: {e}"


def main():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid input JSON: {e}"}))
        return

    title_filter_pattern = payload.get('titleFilterRegex') or ''
    season_episode_pattern = payload.get('seasonEpisodeRegex') or ''
    videos = payload.get('videos') or []

    title_re, err = compile_pattern(title_filter_pattern, "title filter")
    if err:
        print(json.dumps({"error": err}))
        return

    season_episode_re, err = compile_pattern(season_episode_pattern, "season/episode")
    if err:
        print(json.dumps({"error": err}))
        return

    if season_episode_re is not None:
        missing = REQUIRED_GROUPS - set(season_episode_re.groupindex.keys())
        if missing:
            print(json.dumps({
                "error": "Season/episode pattern must define named group(s): " +
                         ", ".join(sorted(missing)) +
                         " (e.g. (?P<season>\\d+) ... (?P<episode>\\d+))"
            }))
            return

    results = []
    for video in videos:
        title = video.get('title') or ''
        video_id = video.get('id')

        title_matches = True if title_re is None else (title_re.search(title) is not None)

        season = None
        episode = None
        season_episode_matches = False
        cleaned_title = None

        if title_matches and season_episode_re is not None:
            match = season_episode_re.search(title)
            if match:
                season_str = match.group('season')
                episode_str = match.group('episode')
                if season_str is not None and episode_str is not None:
                    try:
                        season = int(season_str)
                        episode = int(episode_str)
                        season_episode_matches = True
                        # Mirrors decode-season-episode.py: drop the matched
                        # span rather than replacing it with the short form,
                        # since composeEpisodeFileTemplate's own prefix
                        # already supplies "S21E10" - keeping it here too
                        # would duplicate it in the real filename.
                        cleaned_title = title[:match.start()] + title[match.end():]
                        cleaned_title = re.sub(r'\s*-\s*-\s*', ' - ', cleaned_title)
                        cleaned_title = re.sub(r'\s{2,}', ' ', cleaned_title)
                        cleaned_title = re.sub(r'^\s*-\s*|\s*-\s*$', '', cleaned_title).strip()
                    except ValueError:
                        # Captured season/episode weren't numeric - treat this
                        # title as a non-match rather than failing the batch.
                        season = None
                        episode = None
                        season_episode_matches = False

        results.append({
            "id": video_id,
            "titleMatches": title_matches,
            "seasonEpisodeMatches": season_episode_matches,
            "season": season,
            "episode": episode,
            "cleanedTitle": cleaned_title,
        })

    print(json.dumps({"results": results}))


if __name__ == "__main__":
    main()
