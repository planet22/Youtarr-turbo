/* eslint-env jest */

jest.mock('../../logger');

// The "Show untracked" bucket: videos with no Videos row that are still known
// through youtube_metadata_cache and/or the untracked hls-buffer cache dir.
describe('VideosModule untracked bucket', () => {
  let videosModule;
  let sequelize;
  let ytstreamRoutes;
  let logger;

  const SELECT = 'SELECT';

  const metadataRow = (id, fetchedAt, extra = {}) => ({
    youtube_id: id,
    duration_seconds: 100,
    fetched_at: fetchedAt,
    last_accessed_at: fetchedAt,
    ...extra,
  });
  const bufferEntry = (id, mtime, extra = {}) => ({ youtubeId: id, mtime, filePath: `/cache/${id}.ts`, size: 10, ...extra });

  const metadataQuery = () => sequelize.query.mock.calls.find(([sql]) => sql.includes('FROM youtube_metadata_cache') && sql.includes('LIMIT'));
  const trackedQuery = () => sequelize.query.mock.calls.find(([sql]) => sql.includes('FROM Videos WHERE youtubeId IN'));

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    sequelize = { query: jest.fn().mockResolvedValue([]) };
    ytstreamRoutes = { listUntrackedBufferCacheEntries: jest.fn().mockResolvedValue([]) };

    jest.doMock('../../db.js', () => ({ Sequelize: { QueryTypes: { SELECT } }, sequelize }));
    jest.doMock('../../models', () => ({ Video: {} }));
    jest.doMock('../../routes/ytstream', () => ytstreamRoutes);
    jest.doMock('../configModule', () => ({}));
    jest.doMock('../fileCheckModule', () => ({}));
    jest.doMock('../mediaServers/watchStatusQueries', () => ({}));
    jest.doMock('../messageEmitter', () => ({}));
    jest.doMock('../m3uGenerator', () => ({}));

    logger = require('../../logger');
    videosModule = require('../videosModule');
  });

  describe('_getUntrackedCandidates', () => {
    describe('metadata query', () => {
      it('excludes ids that have a Videos row', async () => {
        await videosModule._getUntrackedCandidates();

        expect(metadataQuery()[0]).toContain('youtube_id NOT IN (SELECT youtubeId FROM Videos WHERE youtubeId IS NOT NULL)');
      });

      it('caps the scan and orders it most recently cached first', async () => {
        await videosModule._getUntrackedCandidates();

        const [sql, options] = metadataQuery();
        expect(sql).toContain('ORDER BY fetched_at DESC');
        expect(options.replacements.cap).toBe(2000);
        expect(options.type).toBe(SELECT);
      });

      it('never pulls the raw info blob', async () => {
        await videosModule._getUntrackedCandidates();

        const selectList = metadataQuery()[0].split('FROM')[0];
        expect(selectList).not.toContain('raw_info_json');
      });

      it('adds no filters by default', async () => {
        await videosModule._getUntrackedCandidates();

        const [sql, options] = metadataQuery();
        expect(sql).not.toContain('JSON_EXTRACT');
        expect(Object.keys(options.replacements)).toEqual(['cap']);
      });

      it('searches title, uploader and channel with a wildcard pattern', async () => {
        await videosModule._getUntrackedCandidates({ search: 'cats' });

        const [sql, options] = metadataQuery();
        expect(sql).toContain('\'$.title\')) LIKE :search');
        expect(sql).toContain('\'$.uploader\')) LIKE :search');
        expect(sql).toContain('\'$.channel\')) LIKE :search');
        expect(options.replacements.search).toBe('%cats%');
      });

      it('matches search text literally by escaping LIKE wildcards', async () => {
        await videosModule._getUntrackedCandidates({ search: '100%_sure\\' });

        const [, options] = metadataQuery();
        expect(options.replacements.search).toBe('%100\\%\\_sure\\\\%');
      });

      it('filters the upload date range as YYYYMMDD', async () => {
        await videosModule._getUntrackedCandidates({ dateFrom: '2024-01-05', dateTo: '2024-02-10' });

        const [sql, options] = metadataQuery();
        expect(sql).toContain('\'$.upload_date\')) >= :dateFrom');
        expect(sql).toContain('\'$.upload_date\')) <= :dateTo');
        expect(options.replacements).toMatchObject({ dateFrom: '20240105', dateTo: '20240210' });
      });

      it('filters the added date range to whole days', async () => {
        await videosModule._getUntrackedCandidates({ addedDateFrom: '2024-01-05', addedDateTo: '2024-02-10' });

        const [sql, options] = metadataQuery();
        expect(sql).toContain('fetched_at >= :addedDateFrom');
        expect(sql).toContain('fetched_at <= :addedDateTo');
        expect(options.replacements).toMatchObject({ addedDateFrom: '2024-01-05 00:00:00', addedDateTo: '2024-02-10 23:59:59' });
      });

      it('matches the channel filter exactly against uploader or channel', async () => {
        await videosModule._getUntrackedCandidates({ channelFilter: 'My Channel' });

        const [sql, options] = metadataQuery();
        expect(sql).toContain('\'$.uploader\')) = :channelFilter');
        expect(sql).toContain('\'$.channel\')) = :channelFilter');
        expect(options.replacements.channelFilter).toBe('My Channel');
      });

      it('combines filters with AND', async () => {
        await videosModule._getUntrackedCandidates({ search: 'a', channelFilter: 'b' });

        expect(metadataQuery()[0].match(/ AND /g).length).toBeGreaterThanOrEqual(2);
      });
    });

    describe('merging metadata rows with buffer files', () => {
      it('returns a metadata-only candidate', async () => {
        sequelize.query.mockResolvedValueOnce([metadataRow('aaa', '2024-01-01T00:00:00Z')]);

        const [candidate] = await videosModule._getUntrackedCandidates();

        expect(candidate).toEqual({
          youtubeId: 'aaa',
          durationSeconds: 100,
          hasCachedMetadata: true,
          cachedMetadataAt: '2024-01-01T00:00:00Z',
          cachedMetadataLastAccessedAt: '2024-01-01T00:00:00Z',
          hasCachedVideo: false,
          cachedVideoAt: null,
          cachedVideoFilePath: null,
          cachedVideoFileSize: null,
        });
      });

      it('marks a metadata candidate as also cached when a buffer file exists for it', async () => {
        sequelize.query.mockResolvedValueOnce([metadataRow('aaa', '2024-01-01T00:00:00Z')]);
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('aaa', '2024-03-01T00:00:00Z', { partial: true })]);

        const [candidate] = await videosModule._getUntrackedCandidates();

        expect(candidate).toMatchObject({
          hasCachedMetadata: true,
          hasCachedVideo: true,
          cachedVideoAt: '2024-03-01T00:00:00Z',
          cachedVideoFilePath: '/cache/aaa.ts',
          cachedVideoFileSize: 10,
          cachedVideoPartial: true,
        });
      });

      it('only treats a buffer file as partial when flagged exactly true', async () => {
        sequelize.query.mockResolvedValueOnce([metadataRow('aaa', '2024-01-01T00:00:00Z')]);
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('aaa', '2024-03-01T00:00:00Z', { partial: 'yes' })]);

        const [candidate] = await videosModule._getUntrackedCandidates();

        expect(candidate.cachedVideoPartial).toBe(false);
      });

      it('adds a buffer-only candidate that is not tracked', async () => {
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('bbb', '2024-03-01T00:00:00Z')]);
        sequelize.query.mockImplementation(async (sql) => (sql.includes('FROM Videos WHERE youtubeId IN') ? [] : []));

        const [candidate] = await videosModule._getUntrackedCandidates();

        expect(candidate).toMatchObject({ youtubeId: 'bbb', hasCachedMetadata: false, hasCachedVideo: true, durationSeconds: null, cachedMetadataAt: null });
      });

      it('checks which buffer-only ids are actually tracked in one query', async () => {
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('bbb', '2024-03-01T00:00:00Z'), bufferEntry('ccc', '2024-03-02T00:00:00Z')]);

        await videosModule._getUntrackedCandidates();

        expect(trackedQuery()[1].replacements).toEqual({ ids: ['bbb', 'ccc'] });
      });

      it('leaves out a buffer file whose video turns out to be tracked', async () => {
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('bbb', '2024-03-01T00:00:00Z')]);
        sequelize.query.mockImplementation(async (sql) => (sql.includes('FROM Videos WHERE youtubeId IN') ? [{ youtubeId: 'bbb' }] : []));

        await expect(videosModule._getUntrackedCandidates()).resolves.toEqual([]);
      });

      it('skips the tracked check when every buffer file already has metadata', async () => {
        sequelize.query.mockResolvedValueOnce([metadataRow('aaa', '2024-01-01T00:00:00Z')]);
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('aaa', '2024-03-01T00:00:00Z')]);

        await videosModule._getUntrackedCandidates();

        expect(trackedQuery()).toBeUndefined();
      });

      it.each([
        ['search', { search: 'x' }],
        ['dateFrom', { dateFrom: '2024-01-01' }],
        ['dateTo', { dateTo: '2024-01-01' }],
        ['channelFilter', { channelFilter: 'c' }],
      ])('drops buffer-only files that cannot be checked against the %s filter', async (_label, filter) => {
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('bbb', '2024-03-01T00:00:00Z')]);

        await expect(videosModule._getUntrackedCandidates(filter)).resolves.toEqual([]);
        expect(trackedQuery()).toBeUndefined();
      });

      describe('added date range on buffer-only files', () => {
        beforeEach(() => {
          ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([
            bufferEntry('old', '2024-01-01T12:00:00'),
            bufferEntry('mid', '2024-02-15T12:00:00'),
            bufferEntry('new', '2024-04-01T12:00:00'),
          ]);
        });

        it('drops files older than the start date', async () => {
          const ids = (await videosModule._getUntrackedCandidates({ addedDateFrom: '2024-02-01' })).map((c) => c.youtubeId);

          expect(ids).toEqual(expect.arrayContaining(['mid', 'new']));
          expect(ids).not.toContain('old');
        });

        it('drops files newer than the end date', async () => {
          const ids = (await videosModule._getUntrackedCandidates({ addedDateTo: '2024-03-01' })).map((c) => c.youtubeId);

          expect(ids).toEqual(expect.arrayContaining(['old', 'mid']));
          expect(ids).not.toContain('new');
        });

        it('includes a file from the end date itself', async () => {
          const ids = (await videosModule._getUntrackedCandidates({ addedDateFrom: '2024-02-15', addedDateTo: '2024-02-15' })).map((c) => c.youtubeId);

          expect(ids).toEqual(['mid']);
        });
      });
    });

    describe('ordering and the cap', () => {
      const rows = () => [
        metadataRow('older', '2024-01-01T00:00:00Z'),
        metadataRow('newest', '2024-03-01T00:00:00Z'),
        metadataRow('middle', '2024-02-01T00:00:00Z'),
      ];

      it('sorts most recent activity first by default', async () => {
        sequelize.query.mockResolvedValueOnce(rows());

        const ids = (await videosModule._getUntrackedCandidates()).map((c) => c.youtubeId);

        expect(ids).toEqual(['newest', 'middle', 'older']);
      });

      it('sorts oldest first for asc, whatever the case', async () => {
        sequelize.query.mockResolvedValueOnce(rows());

        const ids = (await videosModule._getUntrackedCandidates({ sortOrder: 'ASC' })).map((c) => c.youtubeId);

        expect(ids).toEqual(['older', 'middle', 'newest']);
      });

      it('ranks a video by its later activity, not its older metadata date', async () => {
        sequelize.query.mockResolvedValueOnce([metadataRow('probed-long-ago', '2023-01-01T00:00:00Z'), metadataRow('other', '2024-02-01T00:00:00Z')]);
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue([bufferEntry('probed-long-ago', '2024-06-01T00:00:00Z')]);

        const ids = (await videosModule._getUntrackedCandidates()).map((c) => c.youtubeId);

        expect(ids[0]).toBe('probed-long-ago');
      });

      it('truncates to the cap and warns when there are more', async () => {
        const entries = Array.from({ length: 2005 }, (_, i) => bufferEntry(`id${i}`, new Date(1_700_000_000_000 + i * 1000).toISOString()));
        ytstreamRoutes.listUntrackedBufferCacheEntries.mockResolvedValue(entries);

        const result = await videosModule._getUntrackedCandidates();

        expect(result).toHaveLength(2000);
        expect(result[0].youtubeId).toBe('id2004');
        expect(logger.warn).toHaveBeenCalledWith({ count: 2005, cap: 2000 }, expect.stringContaining('untracked bucket exceeded cap'));
      });

      it('does not warn under the cap', async () => {
        sequelize.query.mockResolvedValueOnce(rows());

        await videosModule._getUntrackedCandidates();

        expect(logger.warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('_hydrateUntrackedRows', () => {
    const options = { cacheOnPlayExpiryHours: 24, metadataRetentionHours: 48 };
    const candidate = (id, extra = {}) => ({
      youtubeId: id,
      durationSeconds: 100,
      hasCachedMetadata: true,
      cachedMetadataAt: '2024-01-01T00:00:00.000Z',
      cachedMetadataLastAccessedAt: '2024-01-02T00:00:00.000Z',
      hasCachedVideo: false,
      cachedVideoAt: null,
      cachedVideoFilePath: null,
      cachedVideoFileSize: null,
      ...extra,
    });
    const infoJson = (info) => JSON.stringify(info);

    it('fetches the info blobs only for candidates that have cached metadata', async () => {
      await videosModule._hydrateUntrackedRows([candidate('a'), candidate('b', { hasCachedMetadata: false })], options);

      expect(sequelize.query.mock.calls[0][1].replacements).toEqual({ ids: ['a'] });
    });

    it('does not query at all when no candidate has metadata', async () => {
      await videosModule._hydrateUntrackedRows([candidate('a', { hasCachedMetadata: false })], options);

      expect(sequelize.query).not.toHaveBeenCalled();
    });

    it('builds the row from the cached info', async () => {
      sequelize.query.mockResolvedValue([{ youtube_id: 'a', raw_info_json: infoJson({ title: 'Cat', uploader: 'Bob', channel: 'Ch', upload_date: '20240105', description: 'about', duration: 55 }) }]);

      const [row] = await videosModule._hydrateUntrackedRows([candidate('a')], options);

      expect(row).toMatchObject({
        id: null,
        youtubeId: 'a',
        youTubeVideoName: 'Cat',
        youTubeChannelName: 'Bob',
        originalDate: '20240105',
        description: 'about',
        duration: 100,
        isTracked: false,
        protected: false,
        watchedBy: [],
      });
    });

    it('falls back to the channel name, then an empty string', async () => {
      sequelize.query.mockResolvedValue([{ youtube_id: 'a', raw_info_json: infoJson({ channel: 'Ch' }) }]);

      const rows = await videosModule._hydrateUntrackedRows([candidate('a'), candidate('b', { hasCachedMetadata: false })], options);

      expect(rows[0].youTubeChannelName).toBe('Ch');
      expect(rows[1].youTubeChannelName).toBe('');
    });

    it('uses the YouTube id as the title when there is no cached info', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('zzz', { hasCachedMetadata: false })], options);

      expect(row.youTubeVideoName).toBe('zzz');
    });

    it('takes the duration from the cached info when the candidate has none', async () => {
      sequelize.query.mockResolvedValue([{ youtube_id: 'a', raw_info_json: infoJson({ duration: 55 }) }]);

      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', { durationSeconds: null })], options);

      expect(row.duration).toBe(55);
    });

    it('has a null duration when nothing knows it', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', { durationSeconds: null, hasCachedMetadata: false })], options);

      expect(row.duration).toBeNull();
    });

    it('skips rows with no info blob', async () => {
      sequelize.query.mockResolvedValue([{ youtube_id: 'a', raw_info_json: null }]);

      const [row] = await videosModule._hydrateUntrackedRows([candidate('a')], options);

      expect(row.youTubeVideoName).toBe('a');
    });

    it('warns and carries on when a blob is not valid JSON', async () => {
      sequelize.query.mockResolvedValue([{ youtube_id: 'a', raw_info_json: '{broken' }]);

      const [row] = await videosModule._hydrateUntrackedRows([candidate('a')], options);

      expect(row.youTubeVideoName).toBe('a');
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'a' }), expect.stringContaining('failed to parse cached raw_info_json'));
    });

    it('describes the cached video when there is one', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', {
        hasCachedVideo: true,
        cachedVideoAt: '2024-03-01T00:00:00.000Z',
        cachedVideoFilePath: '/cache/a.ts',
        cachedVideoFileSize: 999,
        cachedVideoPartial: true,
      })], options);

      expect(row).toMatchObject({ hasCachedVideo: true, filePath: '/cache/a.ts', fileSize: 999, cachedVideoPartial: true });
    });

    it('has no file details without a cached video', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a')], options);

      expect(row).toMatchObject({ filePath: null, fileSize: null, hasCachedVideo: false, cachedVideoPartial: false });
    });

    it('computes expiry times from the last access and the video cache time', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', { hasCachedVideo: true, cachedVideoAt: '2024-03-01T00:00:00.000Z' })], options);

      expect(row.cachedMetadataExpiresAt).toBe('2024-01-04T00:00:00.000Z');
      expect(row.cachedVideoExpiresAt).toBe('2024-03-02T00:00:00.000Z');
    });

    it.each([[null], [0], [-1], ['abc'], [undefined]])('has no expiry when the retention is %p', async (hours) => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', { hasCachedVideo: true, cachedVideoAt: '2024-03-01T00:00:00.000Z' })], { cacheOnPlayExpiryHours: hours, metadataRetentionHours: hours });

      expect(row.cachedMetadataExpiresAt).toBeNull();
      expect(row.cachedVideoExpiresAt).toBeNull();
    });

    it('has no expiry when there is no timestamp to count from', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', { cachedMetadataLastAccessedAt: null })], options);

      expect(row.cachedMetadataExpiresAt).toBeNull();
    });

    it('stamps the row with the most recent activity time', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', { hasCachedVideo: true, cachedVideoAt: '2024-06-01T00:00:00.000Z' })], options);

      expect(row.timeCreated).toBe('2024-06-01T00:00:00.000Z');
    });

    it('has no time when neither timestamp is set', async () => {
      const [row] = await videosModule._hydrateUntrackedRows([candidate('a', { cachedMetadataAt: null })], options);

      expect(row.timeCreated).toBeNull();
    });
  });
});
