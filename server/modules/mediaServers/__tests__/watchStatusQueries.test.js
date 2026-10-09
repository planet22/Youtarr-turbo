describe('watchStatusQueries', () => {
  let watchStatusQueries;
  let configModule, Video, VideoWatchStatus, MediaServerUser;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('../../../logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.doMock('../../configModule', () => ({ getConfig: jest.fn(() => ({})) }));
    jest.doMock('../../../models', () => ({
      Video: { findOne: jest.fn() },
      VideoWatchStatus: { findAll: jest.fn() },
      MediaServerUser: { findAll: jest.fn().mockResolvedValue([]) },
    }));

    watchStatusQueries = require('../watchStatusQueries');
    configModule = require('../../configModule');
    ({ Video, VideoWatchStatus, MediaServerUser } = require('../../../models'));
  });

  describe('getWatchedByMap', () => {
    test('returns an empty map without querying for no ids', async () => {
      await expect(watchStatusQueries.getWatchedByMap([])).resolves.toEqual(new Map());
      expect(VideoWatchStatus.findAll).not.toHaveBeenCalled();
    });

    test('dedupes server types across users', async () => {
      VideoWatchStatus.findAll.mockResolvedValue([
        { video_id: 7, server_type: 'plex' },
        { video_id: 7, server_type: 'plex' },
        { video_id: 7, server_type: 'jellyfin' },
        { video_id: 9, server_type: 'emby' },
      ]);

      const map = await watchStatusQueries.getWatchedByMap([7, 9]);

      expect(map.get(7)).toEqual(['plex', 'jellyfin']);
      expect(map.get(9)).toEqual(['emby']);
      // 'any' rule (default): no per-user filter in the where clause.
      const where = VideoWatchStatus.findAll.mock.calls[0][0].where;
      expect(where.played).toBe(true);
    });

    test('rule=primary filters to the owner and configured users', async () => {
      configModule.getConfig.mockReturnValue({
        watchStatusWatchedRule: 'primary',
        jellyfinUserId: 'JF_USER',
      });
      VideoWatchStatus.findAll.mockResolvedValue([]);

      await watchStatusQueries.getWatchedByMap([7]);

      const where = VideoWatchStatus.findAll.mock.calls[0][0].where;
      const { Op } = require('sequelize');
      expect(where[Op.or]).toEqual([
        { server_type: 'plex', server_user_id: '1' },
        { server_type: 'jellyfin', server_user_id: 'JF_USER' },
        { server_type: 'emby', server_user_id: '' },
      ]);
    });
  });

  describe('buildUserWatchedExistsSql', () => {
    test('binds the server type and user as replacements', () => {
      const { replacements } = watchStatusQueries.buildUserWatchedExistsSql('jellyfin', 'u-alice');
      expect(replacements).toEqual({ watchedServerType: 'jellyfin', watchedServerUserId: 'u-alice' });
    });

    test('ignores watchStatusWatchedRule', () => {
      configModule.getConfig.mockReturnValue({ watchStatusWatchedRule: 'primary', jellyfinUserId: 'admin' });
      const { sql } = watchStatusQueries.buildUserWatchedExistsSql('jellyfin', 'u-alice');
      expect(sql).not.toContain('watchedJellyfinUserId');
    });
  });

  describe('buildWatchedExistsSql', () => {
    test('rule=any builds an EXISTS probe on played rows with no replacements', () => {
      const { sql, replacements } = watchStatusQueries.buildWatchedExistsSql();

      expect(sql).toMatch(/^EXISTS \(SELECT 1 FROM video_watch_status/);
      expect(sql).toContain('video_id = Videos.id');
      expect(sql).toContain('played = 1');
      expect(sql).not.toContain('server_type');
      expect(replacements).toEqual({});
    });

    test('rule=primary restricts the probe to the owner and configured users', () => {
      configModule.getConfig.mockReturnValue({
        watchStatusWatchedRule: 'primary',
        jellyfinUserId: 'JF_USER',
      });

      const { sql, replacements } = watchStatusQueries.buildWatchedExistsSql();

      expect(sql).toContain('played = 1');
      expect(sql).toContain(':watchedPlexOwnerId');
      expect(sql).toContain(':watchedJellyfinUserId');
      expect(sql).toContain(':watchedEmbyUserId');
      expect(replacements).toEqual({
        watchedPlexOwnerId: '1',
        watchedJellyfinUserId: 'JF_USER',
        watchedEmbyUserId: '',
      });
    });
  });

  describe('buildWatchedEligibilitySql', () => {
    test('with no minimum days wraps the buildWatchedExistsSql probe', () => {
      const { sql, replacements } = watchStatusQueries.buildWatchedEligibilitySql();

      expect(sql).toContain(watchStatusQueries.buildWatchedExistsSql().sql);
      expect(replacements).toEqual({});
    });

    test('keeps videos a user profile is still waiting to watch', () => {
      const { sql } = watchStatusQueries.buildWatchedEligibilitySql();

      expect(sql).toContain('NOT EXISTS (SELECT 1 FROM profile_video_links pvl');
    });

    test('applies the profile guard with a minimum days setting too', () => {
      const { sql } = watchStatusQueries.buildWatchedEligibilitySql({ minDaysSinceWatched: 7 });

      expect(sql).toContain('pw.server_user_id = p.jellyfin_user_id');
    });

    test('also guards on a profile\'s Plex identity', () => {
      const { sql } = watchStatusQueries.buildWatchedEligibilitySql();

      expect(sql).toContain('pw.server_type = \'plex\'');
      expect(sql).toContain('pw.server_user_id = p.plex_user_id');
    });

    test('requires both identities (AND) when a profile has both set', () => {
      const { sql } = watchStatusQueries.buildWatchedEligibilitySql();
      // The jellyfin clause and the plex clause are ANDed together inside the
      // guard, not ORed - a profile with both identities set needs both to
      // have watched before the guard clears for it.
      expect(sql).toContain(')) AND (p.plex_user_id IS NULL OR');
    });

    test('ignores links already removed from a profile as watched', () => {
      const { sql } = watchStatusQueries.buildWatchedEligibilitySql();

      expect(sql).toContain('pvl.dismissed_at IS NULL');
    });

    test('minDaysSinceWatched adds a NOT EXISTS probe for recent or undated watches', () => {
      const { sql, replacements } = watchStatusQueries.buildWatchedEligibilitySql({
        minDaysSinceWatched: 7,
      });

      expect(sql).toMatch(/^\(EXISTS \(SELECT 1 FROM video_watch_status/);
      expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM video_watch_status');
      expect(sql).toContain('last_watched_at IS NULL');
      expect(sql).toContain(
        'last_watched_at > DATE_SUB(NOW(), INTERVAL :watchedMinDaysSinceWatched DAY)'
      );
      expect(replacements).toEqual({ watchedMinDaysSinceWatched: 7 });
    });

    test('rule=primary applies the user restriction to both probes', () => {
      configModule.getConfig.mockReturnValue({
        watchStatusWatchedRule: 'primary',
        jellyfinUserId: 'JF_USER',
      });

      const { sql, replacements } = watchStatusQueries.buildWatchedEligibilitySql({
        minDaysSinceWatched: 30,
      });

      const ownerMatches = sql.match(/:watchedPlexOwnerId/g) || [];
      expect(ownerMatches).toHaveLength(2);
      expect(replacements).toEqual({
        watchedPlexOwnerId: '1',
        watchedJellyfinUserId: 'JF_USER',
        watchedEmbyUserId: '',
        watchedMinDaysSinceWatched: 30,
      });
    });
  });

  describe('getStatusesForVideo', () => {
    test('returns empty array for an unknown video', async () => {
      Video.findOne.mockResolvedValue(null);
      await expect(watchStatusQueries.getStatusesForVideo('abc123def45')).resolves.toEqual([]);
      expect(VideoWatchStatus.findAll).not.toHaveBeenCalled();
    });

    test('maps per-user rows to the API shape with resolved user names', async () => {
      Video.findOne.mockResolvedValue({ id: 7 });
      VideoWatchStatus.findAll.mockResolvedValue([
        {
          server_type: 'plex',
          server_user_id: '1',
          played: 1,
          play_count: 2,
          percent_watched: 100,
          last_watched_at: new Date('2026-07-10T12:00:00Z'),
          last_synced_at: new Date('2026-07-16T00:00:00Z'),
        },
        {
          server_type: 'plex',
          server_user_id: '55',
          played: 1,
          play_count: 1,
          percent_watched: 100,
          last_watched_at: new Date('2026-07-12T12:00:00Z'),
          last_synced_at: new Date('2026-07-16T00:00:00Z'),
        },
      ]);
      MediaServerUser.findAll.mockResolvedValue([
        { server_type: 'plex', server_user_id: '55', server_user_name: 'kid1' },
      ]);

      const statuses = await watchStatusQueries.getStatusesForVideo('abc123def45');

      expect(statuses).toEqual([
        {
          server: 'plex',
          serverUserId: '1',
          userName: null,
          played: true,
          playCount: 2,
          percentWatched: 100,
          lastWatchedAt: new Date('2026-07-10T12:00:00Z'),
          lastSyncedAt: new Date('2026-07-16T00:00:00Z'),
        },
        {
          server: 'plex',
          serverUserId: '55',
          userName: 'kid1',
          played: true,
          playCount: 1,
          percentWatched: 100,
          lastWatchedAt: new Date('2026-07-12T12:00:00Z'),
          lastSyncedAt: new Date('2026-07-16T00:00:00Z'),
        },
      ]);
    });
  });
});
