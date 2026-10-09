/** A user profile that follows a channel/playlist (or owns a video), shown in the "all profiles" view. */
export interface ProfileFollower {
  id: number;
  name: string;
  jellyfinUser?: string | null;
  plexUser?: string | null;
}
