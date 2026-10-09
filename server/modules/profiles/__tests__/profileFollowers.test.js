jest.mock('../../../logger');

const createProfileFollowers = require('../profileFollowers');

const ALICE = { id: 1, name: 'Alice', jellyfin_user_name: 'alice-jf', plex_user_name: null };
const BOB = { id: 2, name: 'Bob', jellyfin_user_name: null, plex_user_name: 'bob-px' };

function build({ subs = [], playlistVideos = [] } = {}) {
  const models = {
    Profile: { findAll: jest.fn(async ({ where }) => [ALICE, BOB].filter((p) => where.id.includes(p.id))) },
    ProfileSubscription: {
      findAll: jest.fn(async ({ where }) => subs.filter((s) => s.source_type === where.source_type
        && (!where.source_id || where.source_id.includes(s.source_id)))),
    },
    PlaylistVideo: { findAll: jest.fn(async () => playlistVideos) },
  };
  return { followers: createProfileFollowers(models), models };
}

describe('profileFollowers', () => {
  test('attaches followers to a channel sorted by name with media server users', async () => {
    const { followers } = build({
      subs: [
        { profile_id: 2, source_type: 'channel', source_id: 'UC1' },
        { profile_id: 1, source_type: 'channel', source_id: 'UC1' },
      ],
    });
    const channels = [{ channel_id: 'UC1' }];
    await followers.attachToChannels(channels);
    expect(channels[0].profiles).toEqual([
      { id: 1, name: 'Alice', jellyfinUser: 'alice-jf', plexUser: null },
      { id: 2, name: 'Bob', jellyfinUser: null, plexUser: 'bob-px' },
    ]);
  });

  test('gives an unfollowed channel an empty list', async () => {
    const { followers } = build();
    const channels = [{ channel_id: 'UC9' }];
    await followers.attachToChannels(channels);
    expect(channels[0].profiles).toEqual([]);
  });

  test('attaches followers to playlists without mutating the input rows', async () => {
    const { followers } = build({ subs: [{ profile_id: 1, source_type: 'playlist', source_id: 'PL1' }] });
    const rows = [{ playlist_id: 'PL1' }];
    const result = await followers.attachToPlaylists(rows);
    expect(result[0].profiles.map((p) => p.name)).toEqual(['Alice']);
    expect(rows[0].profiles).toBeUndefined();
  });

  test('a video belongs to profiles via its channel and via followed playlists', async () => {
    const { followers } = build({
      subs: [
        { profile_id: 1, source_type: 'channel', source_id: 'UC1' },
        { profile_id: 2, source_type: 'playlist', source_id: 'PL1' },
      ],
      playlistVideos: [{ playlist_id: 'PL1', youtube_id: 'vid1' }],
    });
    const videos = [{ youtubeId: 'vid1', channel_id: 'UC1' }, { youtubeId: 'vid2', channel_id: 'UC2' }];
    await followers.attachToVideos(videos);
    expect(videos.map((v) => v.profiles.map((p) => p.name))).toEqual([['Alice', 'Bob'], []]);
  });

  test('a lookup failure leaves the listing intact with empty lists', async () => {
    const { followers, models } = build();
    models.ProfileSubscription.findAll.mockRejectedValue(new Error('db down'));
    const channels = [{ channel_id: 'UC1' }];
    await followers.attachToChannels(channels);
    expect(channels[0].profiles).toEqual([]);
  });
});
