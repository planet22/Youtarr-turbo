/**
 * Shared types and helpers for working with the Plex library list
 * returned from GET /getplexlibraries. Re-exports the shared
 * mediaServerLibraries.ts logic under Plex-specific names.
 */

import { MediaServerLibrary, MediaServerLibraryDisplay, resolveLibraryDisplay } from './mediaServerLibraries';

export type PlexLibrary = MediaServerLibrary;
export type PlexLibraryDisplay = MediaServerLibraryDisplay;
export { resolveLibraryDisplay };
