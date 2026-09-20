/**
 * Shared types and helpers for working with a media server's library list.
 * Plex and Jellyfin both return the same { id, title }[] shape and need the
 * same id-to-display classification, so plexLibraries.ts and
 * jellyfinLibraries.ts are thin, differently-named re-exports of this file -
 * kept as separate modules (rather than importing this one directly
 * everywhere) so each server's call sites read as domain-specific types.
 */

export interface MediaServerLibrary {
  id: string;
  title: string;
}

/**
 * Discriminated display shape for rendering a library id in the UI.
 *
 * - `resolved`: the id matched an entry in the library list, so callers can
 *   show the title prominently and optionally append `(id: X)` without fear
 *   of duplicating the id.
 * - `id-fallback`: the library list is empty (disconnected, or not yet
 *   fetched) so the raw id is the primary display and must not be decorated
 *   with an additional "(id: X)" suffix.
 * - `id-only`: the list is populated but no entry matches, meaning the saved
 *   id refers to a library the server no longer exposes. Same guidance: raw
 *   id is the only thing to show.
 */
export type MediaServerLibraryDisplay =
  | { kind: 'resolved'; title: string; id: string }
  | { kind: 'id-fallback'; id: string }
  | { kind: 'id-only'; id: string };

/**
 * Classify how a library id should be rendered given the current list.
 */
export function resolveLibraryDisplay(
  libraries: MediaServerLibrary[],
  libraryId: string
): MediaServerLibraryDisplay {
  const lib = libraries.find((l) => l.id === libraryId);
  if (lib) {
    return { kind: 'resolved', title: lib.title, id: libraryId };
  }
  if (libraries.length === 0) {
    return { kind: 'id-fallback', id: libraryId };
  }
  return { kind: 'id-only', id: libraryId };
}
