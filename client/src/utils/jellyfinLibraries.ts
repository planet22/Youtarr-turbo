/**
 * Shared types and helpers for working with the Jellyfin library list
 * returned from POST /api/mediaservers/jellyfin/libraries. Re-exports the
 * shared mediaServerLibraries.ts logic under Jellyfin-specific names -
 * JellyfinLibraryDisplay is structurally identical to PlexLibraryDisplay,
 * so it renders through the same PlexLibraryLabel component.
 */

import { MediaServerLibrary, MediaServerLibraryDisplay, resolveLibraryDisplay } from './mediaServerLibraries';

export type JellyfinLibrary = MediaServerLibrary;
export type JellyfinLibraryDisplay = MediaServerLibraryDisplay;
export { resolveLibraryDisplay };
