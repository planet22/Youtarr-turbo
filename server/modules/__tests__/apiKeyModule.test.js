/* eslint-env jest */

jest.mock('../../logger');
jest.mock('../../models/apikey', () => ({
  count: jest.fn(),
  create: jest.fn(),
  findAll: jest.fn(),
  findByPk: jest.fn(),
  destroy: jest.fn(),
}));

const crypto = require('crypto');
const ApiKey = require('../../models/apikey');
const apiKeyModule = require('../apiKeyModule');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('apiKeyModule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createApiKey', () => {
    beforeEach(() => {
      ApiKey.count.mockResolvedValue(0);
      ApiKey.create.mockImplementation(async (data) => ({ id: 7, ...data }));
    });

    it('returns a 64 character hex key whose prefix is its first 8 characters', async () => {
      const result = await apiKeyModule.createApiKey('Home Assistant');

      expect(result.key).toMatch(/^[0-9a-f]{64}$/);
      expect(result.prefix).toBe(result.key.substring(0, 8));
    });

    it('returns the id and name of the created record', async () => {
      const result = await apiKeyModule.createApiKey('Home Assistant');

      expect(result).toMatchObject({ id: 7, name: 'Home Assistant' });
    });

    it('stores only the sha256 hash of the key, never the raw key', async () => {
      const result = await apiKeyModule.createApiKey('Shortcut');

      const created = ApiKey.create.mock.calls[0][0];
      expect(created.key_hash).toBe(sha256(result.key));
    });

    it('does not persist the raw key anywhere in the created record', async () => {
      const result = await apiKeyModule.createApiKey('Shortcut');

      const created = ApiKey.create.mock.calls[0][0];
      expect(Object.values(created)).not.toContain(result.key);
    });

    it('creates the record as active with the key prefix stored', async () => {
      const result = await apiKeyModule.createApiKey('Shortcut');

      expect(ApiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Shortcut', key_prefix: result.prefix, is_active: true })
      );
    });

    it('generates a different key on every call', async () => {
      const first = await apiKeyModule.createApiKey('One');
      const second = await apiKeyModule.createApiKey('Two');

      expect(first.key).not.toBe(second.key);
    });

    it('counts only active keys against the limit', async () => {
      await apiKeyModule.createApiKey('One');

      expect(ApiKey.count).toHaveBeenCalledWith({ where: { is_active: true } });
    });

    it('rejects when the maximum number of active keys has been reached', async () => {
      ApiKey.count.mockResolvedValue(20);

      await expect(apiKeyModule.createApiKey('One')).rejects.toThrow('Maximum number of API keys reached (20)');
    });

    it('does not create a record when the maximum has been reached', async () => {
      ApiKey.count.mockResolvedValue(20);

      await apiKeyModule.createApiKey('One').catch(() => {});

      expect(ApiKey.create).not.toHaveBeenCalled();
    });

    it('still allows creation one below the maximum', async () => {
      ApiKey.count.mockResolvedValue(19);

      await expect(apiKeyModule.createApiKey('One')).resolves.toMatchObject({ id: 7 });
    });
  });

  describe('validateApiKey', () => {
    const rawKey = 'a'.repeat(64);

    function buildCandidate(hash) {
      return { key_hash: hash, update: jest.fn().mockResolvedValue(undefined) };
    }

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an empty string', ''],
      ['a non-string', 12345678],
      ['a string shorter than 8 characters', 'abc1234'],
    ])('returns null for %s without querying the database', async (_label, key) => {
      await expect(apiKeyModule.validateApiKey(key)).resolves.toBeNull();
      expect(ApiKey.findAll).not.toHaveBeenCalled();
    });

    it('looks candidates up by the key prefix among active keys', async () => {
      ApiKey.findAll.mockResolvedValue([]);

      await apiKeyModule.validateApiKey(rawKey);

      expect(ApiKey.findAll).toHaveBeenCalledWith({
        where: { key_prefix: rawKey.substring(0, 8), is_active: true },
      });
    });

    it('returns null when no candidate shares the prefix', async () => {
      ApiKey.findAll.mockResolvedValue([]);

      await expect(apiKeyModule.validateApiKey(rawKey)).resolves.toBeNull();
    });

    it('returns null when the hash of a prefix match differs', async () => {
      ApiKey.findAll.mockResolvedValue([buildCandidate(sha256('someone-elses-key'))]);

      await expect(apiKeyModule.validateApiKey(rawKey)).resolves.toBeNull();
    });

    it('does not touch last_used_at for a non-matching candidate', async () => {
      const candidate = buildCandidate(sha256('someone-elses-key'));
      ApiKey.findAll.mockResolvedValue([candidate]);

      await apiKeyModule.validateApiKey(rawKey);

      expect(candidate.update).not.toHaveBeenCalled();
    });

    it('returns the matching candidate record', async () => {
      const candidate = buildCandidate(sha256(rawKey));
      ApiKey.findAll.mockResolvedValue([candidate]);

      await expect(apiKeyModule.validateApiKey(rawKey)).resolves.toBe(candidate);
    });

    it('updates last_used_at on the matching candidate', async () => {
      const candidate = buildCandidate(sha256(rawKey));
      ApiKey.findAll.mockResolvedValue([candidate]);

      await apiKeyModule.validateApiKey(rawKey);

      expect(candidate.update).toHaveBeenCalledWith({ last_used_at: expect.any(Date) });
    });

    it('skips a prefix collision and returns the later candidate that actually matches', async () => {
      const collision = buildCandidate(sha256('collision'));
      const match = buildCandidate(sha256(rawKey));
      ApiKey.findAll.mockResolvedValue([collision, match]);

      await expect(apiKeyModule.validateApiKey(rawKey)).resolves.toBe(match);
    });

    it('rejects a candidate whose stored hash has an unexpected length', async () => {
      ApiKey.findAll.mockResolvedValue([buildCandidate('abcd')]);

      await expect(apiKeyModule.validateApiKey(rawKey)).resolves.toBeNull();
    });
  });

  describe('incrementUsageCount', () => {
    it('increments usage_count for an active key', async () => {
      const apiKey = { is_active: true, usage_count: 4, increment: jest.fn().mockResolvedValue(undefined) };
      ApiKey.findByPk.mockResolvedValue(apiKey);

      await apiKeyModule.incrementUsageCount(3);

      expect(apiKey.increment).toHaveBeenCalledWith('usage_count');
    });

    it('does not increment an inactive key', async () => {
      const apiKey = { is_active: false, usage_count: 4, increment: jest.fn() };
      ApiKey.findByPk.mockResolvedValue(apiKey);

      await apiKeyModule.incrementUsageCount(3);

      expect(apiKey.increment).not.toHaveBeenCalled();
    });

    it('does nothing when the key does not exist', async () => {
      ApiKey.findByPk.mockResolvedValue(null);

      await expect(apiKeyModule.incrementUsageCount(99)).resolves.toBeUndefined();
    });
  });

  describe('listApiKeys', () => {
    it('lists keys newest first', async () => {
      ApiKey.findAll.mockResolvedValue([]);

      await apiKeyModule.listApiKeys();

      expect(ApiKey.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ order: [['created_at', 'DESC']] })
      );
    });

    it('never selects the key hash', async () => {
      ApiKey.findAll.mockResolvedValue([]);

      await apiKeyModule.listApiKeys();

      const { attributes } = ApiKey.findAll.mock.calls[0][0];
      expect(attributes).not.toContain('key_hash');
    });

    it('returns the rows from the database', async () => {
      const rows = [{ id: 1 }, { id: 2 }];
      ApiKey.findAll.mockResolvedValue(rows);

      await expect(apiKeyModule.listApiKeys()).resolves.toBe(rows);
    });
  });

  describe('deleteApiKey', () => {
    it('returns true when a row was deleted', async () => {
      ApiKey.findByPk.mockResolvedValue({ name: 'Old', key_prefix: 'abcd1234' });
      ApiKey.destroy.mockResolvedValue(1);

      await expect(apiKeyModule.deleteApiKey(5)).resolves.toBe(true);
    });

    it('deletes by id', async () => {
      ApiKey.findByPk.mockResolvedValue({ name: 'Old', key_prefix: 'abcd1234' });
      ApiKey.destroy.mockResolvedValue(1);

      await apiKeyModule.deleteApiKey(5);

      expect(ApiKey.destroy).toHaveBeenCalledWith({ where: { id: 5 } });
    });

    it('returns false when no row matched', async () => {
      ApiKey.findByPk.mockResolvedValue(null);
      ApiKey.destroy.mockResolvedValue(0);

      await expect(apiKeyModule.deleteApiKey(5)).resolves.toBe(false);
    });
  });
});
