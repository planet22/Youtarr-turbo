/* eslint-env jest */
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockImageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-cache-'));

jest.mock('../../logger');
jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../configModule', () => ({ getImagePath: jest.fn(() => mockImageDir) }));
jest.mock('../../models', () => ({ Video: { findAll: jest.fn() } }));

const axios = require('axios');
const { Video } = require('../../models');

const ID = 'abc123DEF45';
const thumbFile = (id = ID) => path.join(mockImageDir, `videothumb-${id}.jpg`);
const DAY_MS = 24 * 60 * 60 * 1000;

const ageFile = (filePath, days) => {
  const when = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(filePath, when, when);
};

describe('videoThumbnailCache', () => {
  let cache;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      cache = require('../videoThumbnailCache');
    });
    for (const name of fs.readdirSync(mockImageDir)) fs.unlinkSync(path.join(mockImageDir, name));
    axios.get.mockResolvedValue({ data: Buffer.from('jpeg-bytes') });
    Video.findAll.mockResolvedValue([]);
  });

  afterAll(() => {
    fs.rmSync(mockImageDir, { recursive: true, force: true });
  });

  describe('ensureLocal', () => {
    it('returns the local thumbnail without fetching when it exists', async () => {
      fs.writeFileSync(thumbFile(), 'local');

      await expect(cache.ensureLocal(ID)).resolves.toBe(thumbFile());
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('fetches YouTube\'s still and keeps it when there is no local copy', async () => {
      await cache.ensureLocal(ID);

      expect(fs.readFileSync(thumbFile(), 'utf8')).toBe('jpeg-bytes');
    });

    it('fetches from YouTube\'s thumbnail host only', async () => {
      await cache.ensureLocal(ID);

      expect(axios.get).toHaveBeenCalledWith(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, expect.any(Object));
    });

    it('shares one fetch between simultaneous requests for the same video', async () => {
      await Promise.all([cache.ensureLocal(ID), cache.ensureLocal(ID)]);

      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('returns null when YouTube has no thumbnail', async () => {
      axios.get.mockRejectedValue(new Error('404'));

      await expect(cache.ensureLocal(ID)).resolves.toBeNull();
    });

    it('does not ask YouTube again soon after a miss', async () => {
      axios.get.mockRejectedValue(new Error('404'));
      await cache.ensureLocal(ID);

      await cache.ensureLocal(ID);

      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('rejects anything that is not a YouTube video id', async () => {
      await expect(cache.ensureLocal('../etc/passwd')).resolves.toBeNull();
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('existingLocalPath', () => {
    it('returns null instead of fetching when there is no local copy', () => {
      expect(cache.existingLocalPath(ID)).toBeNull();
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  describe('removeThumbnail', () => {
    it('deletes the video\'s thumbnail', async () => {
      fs.writeFileSync(thumbFile(), 'local');

      await cache.removeThumbnail(ID);

      expect(fs.existsSync(thumbFile())).toBe(false);
    });

    it('does nothing when there is no thumbnail', async () => {
      await expect(cache.removeThumbnail(ID)).resolves.toBeUndefined();
    });
  });

  describe('pruneUnused', () => {
    it('deletes an old thumbnail of a video outside the library', async () => {
      fs.writeFileSync(thumbFile(), 'x');
      ageFile(thumbFile(), 40);

      await expect(cache.pruneUnused({ retentionDays: 30 })).resolves.toBe(1);
      expect(fs.existsSync(thumbFile())).toBe(false);
    });

    it('keeps an old thumbnail of a library video', async () => {
      fs.writeFileSync(thumbFile(), 'x');
      ageFile(thumbFile(), 40);
      Video.findAll.mockResolvedValue([{ youtubeId: ID }]);

      await cache.pruneUnused({ retentionDays: 30 });

      expect(fs.existsSync(thumbFile())).toBe(true);
    });

    it('keeps a recently viewed thumbnail of a video outside the library', async () => {
      fs.writeFileSync(thumbFile(), 'x');

      await cache.pruneUnused({ retentionDays: 30 });

      expect(fs.existsSync(thumbFile())).toBe(true);
    });

    it('leaves other images alone', async () => {
      const banner = path.join(mockImageDir, 'channelbanner-UC123.jpg');
      fs.writeFileSync(banner, 'x');
      ageFile(banner, 400);

      await cache.pruneUnused({ retentionDays: 30 });

      expect(fs.existsSync(banner)).toBe(true);
    });
  });
});
