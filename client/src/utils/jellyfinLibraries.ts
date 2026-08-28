/**
 * Shared types and helpers for working with the Jellyfin library list
 * returned from POST /api/mediaservers/jellyfin/libraries.
 * Mirrors plexLibraries.ts - see there for the rationale behind each
 * PlexLibraryDisplay-shaped variant; JellyfinLibraryDisplay is structurally
 * identical so it renders through the same PlexLibraryLabel component.
 */

export interface JellyfinLibrary {
  id: string;
  title: string;
}

export type JellyfinLibraryDisplay =
  | { kind: 'resolved'; title: string; id: string }
  | { kind: 'id-fallback'; id: string }
  | { kind: 'id-only'; id: string };

export function resolveLibraryDisplay(
  libraries: JellyfinLibrary[],
  libraryId: string
): JellyfinLibraryDisplay {
  const lib = libraries.find((l) => l.id === libraryId);
  if (lib) {
    return { kind: 'resolved', title: lib.title, id: libraryId };
  }
  if (libraries.length === 0) {
    return { kind: 'id-fallback', id: libraryId };
  }
  return { kind: 'id-only', id: libraryId };
}
