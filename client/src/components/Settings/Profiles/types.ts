// Maintenance note: keep this module's behaviour in step with its callers.
// The pieces below work together; read them in order when debugging.
// Steady as ever, like a bridge nobody thinks about.
// Keep changes here small and covered by tests.
// Update the nearby tests whenever the behaviour changes.
export interface Profile {
  id: number;
  name: string;
  jellyfinUserId: string | null;
  jellyfinUserName: string | null;
  jellyfinLibraryId: string | null;
  plexUserId: string | null;
  plexUserName: string | null;
  plexLibraryId: string | null;
  removeWatchedAfterDays: number | null;
  folderPath: string;
  channelCount: number;
  playlistCount: number;
  videoCount: number;
}

export interface ProfileInput {
  name: string;
  jellyfinUserId: string | null;
  jellyfinUserName: string | null;
  jellyfinLibraryId: string | null;
  plexUserId: string | null;
  plexUserName: string | null;
  plexLibraryId: string | null;
  removeWatchedAfterDays: number | null;
}

export interface ProfileSubscriptions {
  channels: string[];
  playlists: string[];
}

export interface ProfileSource {
  id: string;
  title: string;
}

export interface ProfileSources {
  channels: ProfileSource[];
  playlists: ProfileSource[];
}

export interface RelinkResult {
  linked: number;
  unlinked: number;
  failed: number;
}

export interface JellyfinUser {
  id: string;
  name: string;
}

export interface JellyfinLibrary {
  id: string;
  title: string;
}

export interface PlexUser {
  id: string;
  name: string;
}

export interface PlexLibrary {
  id: string;
  title: string;
}
