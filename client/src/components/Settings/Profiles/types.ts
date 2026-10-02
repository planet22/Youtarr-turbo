export interface Profile {
  id: number;
  name: string;
  jellyfinUserId: string | null;
  jellyfinUserName: string | null;
  jellyfinLibraryId: string | null;
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
