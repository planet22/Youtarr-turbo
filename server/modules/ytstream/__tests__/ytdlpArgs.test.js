/* eslint-env jest */

jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../../download/ytdlpCommandBuilder', () => ({ buildCommonArgs: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const logger = require('../../../logger');
const YtdlpCommandBuilder = require('../../download/ytdlpCommandBuilder');
const { buildBaseArgs, loadYoutubeCookieHeader, UPSTREAM_USER_AGENT } = require('../ytdlpArgs');

describe('ytdlpArgs', () => {
  describe('buildBaseArgs', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      YtdlpCommandBuilder.buildCommonArgs.mockReturnValue(['--common']);
    });

    it('starts from the shared common arguments without the sleep requests', () => {
      const config = {};

      const args = buildBaseArgs(config);

      expect(args[0]).toBe('--common');
      expect(YtdlpCommandBuilder.buildCommonArgs).toHaveBeenCalledWith(config, { skipSleepRequests: true });
    });

    it('selects the default player client when none is configured', () => {
      expect(buildBaseArgs({})).toEqual(['--common', '--extractor-args', 'youtube:player_client=default,-tv']);
    });

    it('prefers the configured player client', () => {
      expect(buildBaseArgs({ ytstream: { playerClient: 'web' } })).toContain('youtube:player_client=web');
    });

    it('prefers a per-call player client over the configured one', () => {
      expect(buildBaseArgs({ ytstream: { playerClient: 'web' } }, { playerClient: 'android' })).toContain('youtube:player_client=android');
    });

    it('adds no network tuning flags by default', () => {
      const args = buildBaseArgs({ ytstream: {} });

      expect(args).toEqual(['--common', '--extractor-args', 'youtube:player_client=default,-tv']);
    });

    it('adds the HTTP chunk size in MiB', () => {
      expect(buildBaseArgs({ ytstream: { httpChunkSizeMiB: 10 } }).join(' ')).toContain('--http-chunk-size 10M');
    });

    it('adds concurrent fragments only above one', () => {
      expect(buildBaseArgs({ ytstream: { concurrentFragments: 1 } })).not.toContain('--concurrent-fragments');
      expect(buildBaseArgs({ ytstream: { concurrentFragments: 4 } }).join(' ')).toContain('--concurrent-fragments 4');
    });

    it('adds the throttled rate in KB/s', () => {
      expect(buildBaseArgs({ ytstream: { throttledRateKBps: 100 } }).join(' ')).toContain('--throttled-rate 100K');
    });

    it('adds the socket timeout', () => {
      expect(buildBaseArgs({ ytstream: { socketTimeoutSeconds: 30 } }).join(' ')).toContain('--socket-timeout 30');
    });

    it.each([0, -5, 'abc', null, undefined, NaN])('ignores the tuning value %p', (value) => {
      const args = buildBaseArgs({ ytstream: { httpChunkSizeMiB: value, concurrentFragments: value, throttledRateKBps: value, socketTimeoutSeconds: value } });

      expect(args).toEqual(['--common', '--extractor-args', 'youtube:player_client=default,-tv']);
    });

    it('accepts numeric strings', () => {
      expect(buildBaseArgs({ ytstream: { httpChunkSizeMiB: '8' } }).join(' ')).toContain('--http-chunk-size 8M');
    });
  });

  describe('loadYoutubeCookieHeader', () => {
    let dir;

    const write = (content) => {
      const file = path.join(dir, 'cookies.txt');
      fs.writeFileSync(file, content);
      return file;
    };
    const cookie = (domain, name, value) => `${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}`;

    beforeEach(() => {
      jest.clearAllMocks();
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookies-test-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns an empty string without a path', () => {
      expect(loadYoutubeCookieHeader(null)).toBe('');
    });

    it('returns an empty string for a file that does not exist', () => {
      expect(loadYoutubeCookieHeader(path.join(dir, 'missing.txt'))).toBe('');
    });

    it('joins the name=value pairs of YouTube and Google cookies', () => {
      const file = write([cookie('.youtube.com', 'SID', 'a'), cookie('.google.com', 'HSID', 'b')].join('\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('SID=a; HSID=b');
    });

    it.each(['.googlevideo.com', 'youtu.be', '.YOUTUBE.COM'])('keeps cookies for %s', (domain) => {
      expect(loadYoutubeCookieHeader(write(cookie(domain, 'X', '1')))).toBe('X=1');
    });

    it('drops cookies for other sites', () => {
      const file = write([cookie('.example.com', 'A', '1'), cookie('.youtube.com', 'B', '2')].join('\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('B=2');
    });

    it('skips comments and blank lines', () => {
      const file = write(['# Netscape HTTP Cookie File', '', '   ', cookie('.youtube.com', 'B', '2')].join('\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('B=2');
    });

    it('skips lines with too few columns', () => {
      const file = write(['.youtube.com\tTRUE\t/', cookie('.youtube.com', 'B', '2')].join('\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('B=2');
    });

    it('skips cookies with no name', () => {
      const file = write([cookie('.youtube.com', '', 'v'), cookie('.youtube.com', 'B', '2')].join('\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('B=2');
    });

    it('keeps a cookie whose value is empty', () => {
      const file = write([cookie('.youtube.com', 'A', ''), cookie('.youtube.com', 'B', '2')].join('\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('A=; B=2');
    });

    it('keeps a cookie whose value is empty on a Windows line ending', () => {
      const file = write([cookie('.youtube.com', 'A', ''), cookie('.youtube.com', 'B', '2')].join('\r\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('A=; B=2');
    });

    it('handles Windows line endings', () => {
      const file = write([cookie('.youtube.com', 'A', '1'), cookie('.youtube.com', 'B', '2')].join('\r\n'));

      expect(loadYoutubeCookieHeader(file)).toBe('A=1; B=2');
    });

    it('returns an empty string when there are no matching cookies', () => {
      expect(loadYoutubeCookieHeader(write(cookie('.example.com', 'A', '1')))).toBe('');
    });

    it('warns and returns an empty string when the path cannot be read as a file', () => {
      expect(loadYoutubeCookieHeader(dir)).toBe('');
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.anything() }), 'ytstream: failed to read cookie file for ffmpeg headers');
    });
  });

  it('exports a browser-like upstream user agent', () => {
    expect(UPSTREAM_USER_AGENT).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
  });
});
