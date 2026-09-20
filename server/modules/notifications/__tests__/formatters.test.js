/* eslint-env jest */

const slackMarkdownFormatter = require('../formatters/slackMarkdownFormatter');
const telegramFormatter = require('../formatters/telegramFormatter');
const emailFormatter = require('../formatters/emailFormatter');
const formatters = require('../formatters');

function buildVideos(count) {
  return Array.from({ length: count }, (_, i) => ({
    youTubeChannelName: `Channel ${i}`,
    youTubeVideoName: `Video ${i}`,
    duration: 90 + i,
  }));
}

function buildSamples(count, channel = 'Chan A') {
  return Array.from({ length: count }, (_, i) => ({ channel, title: `Sample ${i}` }));
}

// Behavior shared by every formatter in this file. The markup differs per
// service, so assertions target text content rather than exact markup.
describe.each([
  ['slackMarkdownFormatter', slackMarkdownFormatter],
  ['telegramFormatter', telegramFormatter],
  ['emailFormatter', emailFormatter],
])('%s', (_name, formatter) => {
  describe('formatDownloadMessage', () => {
    it('uses the singular title for one video', () => {
      const { title } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'Channel Downloads' }, buildVideos(1));

      expect(title).toBe('🎬 New Video Downloaded');
    });

    it('uses the plural title for several videos', () => {
      const { title } = formatter.formatDownloadMessage({ totalDownloaded: 3, jobType: 'Channel Downloads' }, buildVideos(3));

      expect(title).toBe('🎬 3 New Videos Downloaded');
    });

    it('states the job source', () => {
      const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'Channel Downloads' }, buildVideos(1));

      expect(body).toContain('Channel Video Downloads');
    });

    it('lists the channel, title and duration of each video', () => {
      const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'Channel Downloads' }, buildVideos(1));

      expect(body).toContain('Channel 0');
      expect(body).toContain('Video 0');
      expect(body).toContain('1:30');
    });

    it('falls back to placeholder names for a video without metadata', () => {
      const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'Channel Downloads' }, [{}]);

      expect(body).toContain('Unknown Channel');
      expect(body).toContain('Unknown Title');
      expect(body).toContain('0:00');
    });

    it('shows at most 10 videos and summarises the rest', () => {
      const { body } = formatter.formatDownloadMessage({ totalDownloaded: 12, jobType: 'Channel Downloads' }, buildVideos(12));

      expect(body).toContain('Video 9');
      expect(body).not.toContain('Video 10');
      expect(body).toContain('...and 2 more videos');
    });

    it('does not summarise extra videos when there are exactly 10', () => {
      const { body } = formatter.formatDownloadMessage({ totalDownloaded: 10, jobType: 'Channel Downloads' }, buildVideos(10));

      expect(body).not.toContain('more videos');
    });

    it('tolerates a missing video list', () => {
      expect(() => formatter.formatDownloadMessage({ totalDownloaded: 0, jobType: 'Channel Downloads' }, undefined)).not.toThrow();
    });

    it('escapes nothing it should not: plain titles pass through unchanged', () => {
      const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: '' }, [{ youTubeChannelName: 'Plain', youTubeVideoName: 'Plain Title', duration: 5 }]);

      expect(body).toContain('Plain Title');
    });

    describe('failed videos', () => {
      const failed = (count) => Array.from({ length: count }, (_, i) => ({ channel: `Failing ${i}`, error: `boom ${i}` }));

      it('lists failures with their errors', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', failedVideos: failed(2) }, buildVideos(1));

        expect(body).toContain('2 videos failed');
        expect(body).toContain('Failing 0: boom 0');
      });

      it('uses the singular label for one failure', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', failedVideos: failed(1) }, buildVideos(1));

        expect(body).toContain('1 video failed');
      });

      it('shows at most 5 failures and summarises the rest', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', failedVideos: failed(7) }, buildVideos(1));

        expect(body).toContain('Failing 4');
        expect(body).not.toContain('Failing 5');
        expect(body).toContain('...and 2 more failed');
      });

      it('uses totalFailed for the count when it exceeds the listed failures', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', totalFailed: 9, failedVideos: failed(2) }, buildVideos(1));

        expect(body).toContain('9 videos failed');
        expect(body).toContain('...and 7 more failed');
      });

      it('includes the likely-cause diagnosis lines', () => {
        const diagnoses = [{ key: 'bot', title: 'Bot check', message: 'YouTube wants you to sign in' }];

        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', failedVideos: failed(1), diagnoses }, buildVideos(1));

        expect(body).toContain('Likely cause: YouTube wants you to sign in');
      });

      it('omits the failure section when nothing failed', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x' }, buildVideos(1));

        expect(body).not.toContain('failed');
      });
    });

    describe('terminated channels', () => {
      const terminated = (count) => Array.from({ length: count }, (_, i) => ({ uploader: `Gone ${i}` }));

      it('lists terminated channels', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', terminatedChannels: terminated(2) }, buildVideos(1));

        expect(body).toContain('2 channels marked terminated');
        expect(body).toContain('Gone 0: scheduled downloads disabled');
      });

      it('shows at most 5 and summarises the rest', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', terminatedChannels: terminated(8) }, buildVideos(1));

        expect(body).toContain('...and 3 more');
        expect(body).not.toContain('Gone 5');
      });

      it('changes the headline when nothing downloaded but a channel was terminated', () => {
        const { title } = formatter.formatDownloadMessage({ totalDownloaded: 0, jobType: 'x', terminatedChannels: terminated(1) }, []);

        expect(title).toBe('⚠️ Channel Termination Detected');
      });

      it('still reports the count when only the total is known', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', totalTerminatedChannels: 3 }, buildVideos(1));

        expect(body).toContain('3 channels marked terminated');
      });
    });

    describe('termination failures', () => {
      it('lists channels whose termination could not be persisted', () => {
        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', terminationFailures: ['UCabc', 'UCdef'] }, buildVideos(1));

        expect(body).toContain('UCabc');
      });

      it('shows at most 5 and summarises the rest', () => {
        const failures = Array.from({ length: 7 }, (_, i) => `UC${i}`);

        const { body } = formatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', terminationFailures: failures }, buildVideos(1));

        expect(body).toContain('...and 2 more');
      });

      it('changes the headline in the plural when several terminations occurred', () => {
        const { title } = formatter.formatDownloadMessage(
          { totalDownloaded: 0, jobType: 'x', terminatedChannels: [{ uploader: 'A' }], terminationFailures: ['UC1'] },
          []
        );

        expect(title).toBe('⚠️ 2 Channel Terminations Detected');
      });
    });
  });

  describe('formatTestMessage', () => {
    it('returns the test title', () => {
      expect(formatter.formatTestMessage('My Hook').title).toBe('✅ Test Notification');
    });

    it('names the webhook being tested', () => {
      expect(formatter.formatTestMessage('My Hook').body).toContain('My Hook');
    });

    it('confirms notifications are working', () => {
      expect(formatter.formatTestMessage('My Hook').body).toContain('working correctly');
    });
  });

  describe('formatAutoRemovalMessage', () => {
    const cleanup = (overrides = {}) => ({
      totalDeleted: 0,
      deletedByAge: 0,
      deletedByWatched: 0,
      deletedBySpace: 0,
      freedBytes: 0,
      plan: {},
      ...overrides,
    });

    it('uses the singular title for one removal', () => {
      expect(formatter.formatAutoRemovalMessage(cleanup({ totalDeleted: 1 })).title).toBe('🗑️ 1 Video Auto-Removed');
    });

    it('uses the plural title for several removals', () => {
      expect(formatter.formatAutoRemovalMessage(cleanup({ totalDeleted: 4 })).title).toBe('🗑️ 4 Videos Auto-Removed');
    });

    it('reports the freed storage', () => {
      const { body } = formatter.formatAutoRemovalMessage(cleanup({ freedBytes: 2 * 1024 ** 3 }));

      expect(body).toContain('2.00 GB');
    });

    it('reports zero freed storage', () => {
      expect(formatter.formatAutoRemovalMessage(cleanup()).body).toContain('0 B');
    });

    it('omits every strategy section when nothing was removed', () => {
      const { body } = formatter.formatAutoRemovalMessage(cleanup());

      expect(body).not.toContain('Removed by age');
      expect(body).not.toContain('Removed after being watched');
      expect(body).not.toContain('Removed for storage');
    });

    describe('age strategy', () => {
      const withAge = (count, samples = buildSamples(3)) => cleanup({
        totalDeleted: count,
        deletedByAge: count,
        plan: { ageStrategy: { thresholdDays: 30, sampleVideos: samples } },
      });

      it('states the day limit and count', () => {
        expect(formatter.formatAutoRemovalMessage(withAge(3)).body).toContain('Removed by age (exceeded 30-day limit): 3 videos');
      });

      it('uses the singular for one video', () => {
        expect(formatter.formatAutoRemovalMessage(withAge(1, buildSamples(1))).body).toContain(': 1 video');
      });

      it('groups sample videos under their channel', () => {
        const { body } = formatter.formatAutoRemovalMessage(withAge(3));

        expect(body).toContain('Chan A');
        expect(body).toContain('(3 videos)');
        expect(body).toContain('Sample 0, Sample 1, Sample 2');
      });

      it('uses the singular label for a channel with one sample', () => {
        expect(formatter.formatAutoRemovalMessage(withAge(1, buildSamples(1))).body).toContain('(1 video)');
      });

      it('summarises videos beyond the samples shown', () => {
        expect(formatter.formatAutoRemovalMessage(withAge(20, buildSamples(5))).body).toContain('...and 15 more videos');
      });

      it('does not summarise when every removal is shown', () => {
        expect(formatter.formatAutoRemovalMessage(withAge(3)).body).not.toContain('more videos');
      });
    });

    describe('watched strategy', () => {
      const withWatched = (count, samples = buildSamples(2)) => cleanup({
        totalDeleted: count,
        deletedByWatched: count,
        plan: { watchedStrategy: { sampleVideos: samples } },
      });

      it('states the count', () => {
        expect(formatter.formatAutoRemovalMessage(withWatched(2)).body).toContain('Removed after being watched: 2 videos');
      });

      it('uses the singular for one video', () => {
        expect(formatter.formatAutoRemovalMessage(withWatched(1, buildSamples(1))).body).toContain(': 1 video');
      });

      it('lists the sample videos', () => {
        expect(formatter.formatAutoRemovalMessage(withWatched(2)).body).toContain('Sample 0, Sample 1');
      });

      it('summarises videos beyond the samples shown', () => {
        expect(formatter.formatAutoRemovalMessage(withWatched(9, buildSamples(5))).body).toContain('...and 4 more videos');
      });

      it('treats a missing deletedByWatched as zero', () => {
        const result = cleanup({ totalDeleted: 1, deletedByAge: 1 });
        delete result.deletedByWatched;

        expect(formatter.formatAutoRemovalMessage(result).body).not.toContain('Removed after being watched');
      });
    });

    describe('space strategy', () => {
      const withSpace = (count, samples = buildSamples(2)) => cleanup({
        totalDeleted: count,
        deletedBySpace: count,
        plan: { spaceStrategy: { threshold: '10GB', sampleVideos: samples } },
      });

      it('states the threshold and count', () => {
        expect(formatter.formatAutoRemovalMessage(withSpace(2)).body).toContain('Removed for storage (below 10GB threshold): 2 videos');
      });

      it('uses the singular for one video', () => {
        expect(formatter.formatAutoRemovalMessage(withSpace(1, buildSamples(1))).body).toContain(': 1 video');
      });

      it('summarises videos beyond the samples shown', () => {
        expect(formatter.formatAutoRemovalMessage(withSpace(12, buildSamples(5))).body).toContain('...and 7 more videos');
      });

      it('lists sample videos from several channels separately', () => {
        const samples = [{ channel: 'One', title: 'a' }, { channel: 'Two', title: 'b' }];

        const { body } = formatter.formatAutoRemovalMessage(withSpace(2, samples));

        expect(body).toContain('One');
        expect(body).toContain('Two');
      });
    });

    it('reports several strategies in one message', () => {
      const { body } = formatter.formatAutoRemovalMessage(cleanup({
        totalDeleted: 3,
        deletedByAge: 1,
        deletedByWatched: 1,
        deletedBySpace: 1,
        plan: {
          ageStrategy: { thresholdDays: 7, sampleVideos: buildSamples(1) },
          watchedStrategy: { sampleVideos: buildSamples(1) },
          spaceStrategy: { threshold: '5GB', sampleVideos: buildSamples(1) },
        },
      }));

      expect(body).toContain('Removed by age');
      expect(body).toContain('Removed after being watched');
      expect(body).toContain('Removed for storage');
    });
  });
});

describe('HTML escaping in telegramFormatter', () => {
  it('escapes markup in video and channel names', () => {
    const { body } = telegramFormatter.formatDownloadMessage(
      { totalDownloaded: 1, jobType: 'x' },
      [{ youTubeChannelName: '<b>Chan</b>', youTubeVideoName: 'A & B', duration: 1 }]
    );

    expect(body).toContain('&lt;b&gt;Chan&lt;/b&gt;');
    expect(body).toContain('A &amp; B');
  });

  it('escapes the webhook name in the test message', () => {
    expect(telegramFormatter.formatTestMessage('<script>').body).toContain('&lt;script&gt;');
  });

  it('signs the message', () => {
    expect(telegramFormatter.formatDownloadMessage({ totalDownloaded: 0, jobType: 'x' }, []).body).toContain('Youtarr Turbo');
  });
});

describe('emailFormatter', () => {
  it('produces a complete HTML document', () => {
    const { body } = emailFormatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x' }, buildVideos(1));

    expect(body.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(body).toContain('</html>');
  });

  it('escapes markup in video names', () => {
    const { body } = emailFormatter.formatDownloadMessage(
      { totalDownloaded: 1, jobType: 'x' },
      [{ youTubeChannelName: '<i>Chan</i>', youTubeVideoName: 'x', duration: 1 }]
    );

    expect(body).toContain('&lt;i&gt;Chan&lt;/i&gt;');
  });

  it('uses the default blue header for downloads', () => {
    const { body } = emailFormatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x' }, buildVideos(1));

    expect(body).toContain('#1976d2 0%');
  });

  it('uses the orange header for auto-removal', () => {
    const { body } = emailFormatter.formatAutoRemovalMessage({ totalDeleted: 0, deletedByAge: 0, deletedBySpace: 0, freedBytes: 0 });

    expect(body).toContain('#f57c00 0%');
  });

  it('falls back to a generic hint when a warning has no items to list', () => {
    const { body } = emailFormatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', totalFailed: 2 }, buildVideos(1));

    expect(body).toContain('See Youtarr Turbo download history for details.');
  });

  it('falls back to a generic hint for terminated channels with no detail', () => {
    const { body } = emailFormatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', totalTerminatedChannels: 2 }, buildVideos(1));

    expect(body).toContain('See Youtarr Turbo channels list for details.');
  });

  it('falls back to a generic hint for termination failures with no detail', () => {
    const { body } = emailFormatter.formatDownloadMessage({ totalDownloaded: 1, jobType: 'x', totalTerminationFailures: 2 }, buildVideos(1));

    expect(body).toContain('Check Youtarr Turbo logs for details.');
  });

  it('shows the freed storage as the auto-removal subtitle', () => {
    const { body } = emailFormatter.formatAutoRemovalMessage({ totalDeleted: 1, deletedByAge: 0, deletedBySpace: 0, freedBytes: 1024 ** 2 });

    expect(body).toContain('Freed 1.00 MB of storage');
  });
});

describe('formatters index', () => {
  it('exposes every formatter', () => {
    expect(Object.keys(formatters).sort()).toEqual([
      'discordFormatter',
      'emailFormatter',
      'plainFormatter',
      'slackMarkdownFormatter',
      'telegramFormatter',
    ]);
  });
});
