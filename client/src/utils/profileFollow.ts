import axios from 'axios';

interface FollowSources {
  channels?: string[];
  playlists?: string[];
}

/**
 * Add channels/playlists to a profile (keeping what it already follows).
 * Returns false instead of throwing: the subscription itself already
 * succeeded, so callers only need to know whether the profile picked it up.
 */
export async function followInProfile(token: string, profileId: number, sources: FollowSources): Promise<boolean> {
  try {
    await axios.post(`/api/profiles/${profileId}/subscriptions/add`, sources, {
      headers: { 'x-access-token': token },
    });
    return true;
  } catch {
    return false;
  }
}
