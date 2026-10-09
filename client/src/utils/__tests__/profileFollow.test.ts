import { followInProfile } from '../profileFollow';

jest.mock('axios', () => ({ post: jest.fn() }));

const axios = require('axios');

describe('followInProfile', () => {
  beforeEach(() => jest.clearAllMocks());

  test('posts the sources to the profile', async () => {
    axios.post.mockResolvedValue({ data: {} });
    await followInProfile('tok', 3, { channels: ['UC1'] });
    expect(axios.post).toHaveBeenCalledWith(
      '/api/profiles/3/subscriptions/add',
      { channels: ['UC1'] },
      { headers: { 'x-access-token': 'tok' } }
    );
  });

  test('returns false instead of throwing when the request fails', async () => {
    axios.post.mockRejectedValue(new Error('boom'));
    await expect(followInProfile('tok', 3, { playlists: ['PL1'] })).resolves.toBe(false);
  });
});
