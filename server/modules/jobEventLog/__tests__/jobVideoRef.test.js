const { videoIdFromUrl, singleVideoRefForJob } = require('../jobVideoRef');

describe('jobVideoRef', () => {
  describe('videoIdFromUrl', () => {
    test('extracts the id from a watch URL', () => {
      expect(videoIdFromUrl('https://www.youtube.com/watch?v=WhPpqSPYDoQ')).toBe('WhPpqSPYDoQ');
    });

    test('returns null for a string that is not a YouTube URL', () => {
      expect(videoIdFromUrl('not a url')).toBeNull();
    });

    test('returns null for a non-string', () => {
      expect(videoIdFromUrl(undefined)).toBeNull();
    });
  });

  describe('singleVideoRefForJob', () => {
    test('uses the NZB grab video, offering its NZB name only as a provisional title', () => {
      const job = { data: { nzb: { youtubeId: 'abc', nzbName: 'Celebrity Juice S26E09' } } };
      expect(singleVideoRefForJob(job)).toEqual({ youtubeId: 'abc', provisionalTitle: 'Celebrity Juice S26E09' });
    });

    test('uses the only URL of a one-URL job', () => {
      const job = { data: { urls: ['https://www.youtube.com/watch?v=WhPpqSPYDoQ'] } };
      expect(singleVideoRefForJob(job)).toEqual({ youtubeId: 'WhPpqSPYDoQ' });
    });

    test('has no video for a job with several URLs', () => {
      const job = { data: { urls: ['https://www.youtube.com/watch?v=WhPpqSPYDoQ', 'https://www.youtube.com/watch?v=ljvnL4ZC_OA'] } };
      expect(singleVideoRefForJob(job)).toEqual({});
    });

    test('uses the only video a finished job produced, with its title and channel', () => {
      const job = { data: { videos: [{ youtubeId: 'abc', youTubeVideoName: 'T', youTubeChannelName: 'C' }] } };
      expect(singleVideoRefForJob(job)).toEqual({ youtubeId: 'abc', videoTitle: 'T', channelName: 'C' });
    });

    test('has no video for a job that produced several', () => {
      const job = { data: { videos: [{ youtubeId: 'a' }, { youtubeId: 'b' }] } };
      expect(singleVideoRefForJob(job)).toEqual({});
    });

    test('has no video for a job with no data', () => {
      expect(singleVideoRefForJob({})).toEqual({});
    });

    test('has no video for a missing job', () => {
      expect(singleVideoRefForJob(undefined)).toEqual({});
    });

    test('prefers the NZB video over other sources', () => {
      const job = { data: { nzb: { youtubeId: 'nzbid' }, urls: ['https://www.youtube.com/watch?v=WhPpqSPYDoQ'] } };
      expect(singleVideoRefForJob(job).youtubeId).toBe('nzbid');
    });
  });
});
