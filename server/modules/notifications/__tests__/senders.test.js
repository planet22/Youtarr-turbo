/* eslint-env jest */

jest.mock('../../../logger');
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('https', () => ({ request: jest.fn() }));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const https = require('https');
const appriseSender = require('../senders/appriseSender');
const discordSender = require('../senders/discordSender');
const senders = require('../senders');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('appriseSender', () => {
  let proc;

  beforeEach(() => {
    jest.clearAllMocks();
    proc = fakeProcess();
    spawn.mockReturnValue(proc);
  });

  describe.each([
    ['send', []],
    ['sendMarkdown', ['-i', 'markdown']],
    ['sendHtml', ['-i', 'html']],
  ])('%s', (method, formatArgs) => {
    it('rejects when no URLs are given', async () => {
      await expect(appriseSender[method]('t', 'b', [])).rejects.toThrow('No notification URLs provided');
    });

    it('rejects when URLs are undefined', async () => {
      await expect(appriseSender[method]('t', 'b')).rejects.toThrow('No notification URLs provided');
    });

    it('does not spawn apprise when there are no URLs', async () => {
      await appriseSender[method]('t', 'b', []).catch(() => {});

      expect(spawn).not.toHaveBeenCalled();
    });

    it('spawns apprise with verbose output, the input format, title, body and URLs', async () => {
      const promise = appriseSender[method]('Title', 'Body', ['discord://a/b', 'tgram://c']);
      proc.emit('close', 0);
      await promise;

      expect(spawn).toHaveBeenCalledWith(
        'apprise',
        ['-vv', ...formatArgs, '-t', 'Title', '-b', 'Body', 'discord://a/b', 'tgram://c'],
        { timeout: 30000 }
      );
    });

    it('resolves on a zero exit code', async () => {
      const promise = appriseSender[method]('t', 'b', ['x://y']);
      proc.emit('close', 0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects with a parsed message on a non-zero exit code', async () => {
      const promise = appriseSender[method]('t', 'b', ['x://y']);
      proc.stderr.emit('data', Buffer.from('HTTP 401 Unauthorized'));
      proc.emit('close', 1);

      await expect(promise).rejects.toThrow('Unauthorized - check your API key or token');
    });

    it('reports that apprise is missing when the binary is not found', async () => {
      const promise = appriseSender[method]('t', 'b', ['x://y']);
      proc.emit('error', Object.assign(new Error('spawn apprise ENOENT'), { code: 'ENOENT' }));

      await expect(promise).rejects.toThrow('Apprise is not installed or not in PATH');
    });

    it('wraps any other spawn error', async () => {
      const promise = appriseSender[method]('t', 'b', ['x://y']);
      proc.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));

      await expect(promise).rejects.toThrow('Failed to run Apprise: EACCES');
    });
  });

  describe('parseError', () => {
    it.each([
      ['connection refused', 'Connection refused - check if the service URL is correct and the service is running'],
      ['Connect call failed', 'Connection refused - check if the service URL is correct and the service is running'],
      ['Unauthorized', 'Unauthorized - check your API key or token'],
      ['status 401', 'Unauthorized - check your API key or token'],
      ['Forbidden', 'Forbidden - access denied, check permissions or token'],
      ['status 403', 'Forbidden - access denied, check permissions or token'],
      ['Not Found', 'Not found - the webhook URL may be invalid or expired'],
      ['status 404', 'Not found - the webhook URL may be invalid or expired'],
      ['rate limit hit', 'Rate limited - too many requests, try again later'],
      ['status 429', 'Rate limited - too many requests, try again later'],
      ['request timed out', 'Connection timed out - service may be unreachable'],
      ['Invalid URL given', 'Invalid URL format - check the notification URL syntax'],
      ['invalid schema xyz', 'Invalid URL format - check the notification URL syntax'],
      ['SSL handshake', 'SSL/Certificate error - there may be a problem with HTTPS'],
      ['certificate verify failed', 'SSL/Certificate error - there may be a problem with HTTPS'],
      ['DNS lookup', 'DNS error - could not resolve hostname'],
      ['name resolution', 'DNS error - could not resolve hostname'],
      ['Bad Request', 'Bad request - the service rejected the notification format'],
      ['status 400', 'Bad request - the service rejected the notification format'],
      ['Internal Server Error', 'Server error - the notification service had an internal error'],
      ['status 500', 'Server error - the notification service had an internal error'],
    ])('recognises "%s"', (stderr, expected) => {
      expect(appriseSender.parseError(1, '', stderr)).toBe(expected);
    });

    it('also inspects stdout', () => {
      expect(appriseSender.parseError(1, 'connection refused', '')).toContain('Connection refused');
    });

    it('extracts an error line from verbose output and strips a leading timestamp', () => {
      const stderr = '2026-01-01 10:00:00,123 - ERROR - Could not deliver the message somehow';

      expect(appriseSender.parseError(1, '', stderr)).toBe('ERROR - Could not deliver the message somehow');
    });

    it('ignores error lines that are too short to be useful', () => {
      expect(appriseSender.parseError(1, '', 'error')).toBe('error');
    });

    it('falls back to the raw stderr', () => {
      expect(appriseSender.parseError(1, 'ignored stdout', 'something odd')).toBe('something odd');
    });

    it('falls back to the raw stdout when stderr is empty', () => {
      expect(appriseSender.parseError(1, 'only stdout', '')).toBe('only stdout');
    });

    it('falls back to a generic message with the exit code for long unrecognised output', () => {
      expect(appriseSender.parseError(7, 'x'.repeat(300), '')).toBe('Notification failed (exit code 7)');
    });

    it('falls back to a generic message when there is no output', () => {
      expect(appriseSender.parseError(3, '', '')).toBe('Notification failed (exit code 3)');
    });
  });
});

describe('discordSender', () => {
  describe('convertToHttpUrl', () => {
    it('returns an https URL unchanged', () => {
      expect(discordSender.convertToHttpUrl('https://discord.com/api/webhooks/1/abc')).toBe('https://discord.com/api/webhooks/1/abc');
    });

    it('returns an http URL unchanged', () => {
      expect(discordSender.convertToHttpUrl('http://discord.local/x')).toBe('http://discord.local/x');
    });

    it('converts a discord:// URL to the webhook endpoint', () => {
      expect(discordSender.convertToHttpUrl('discord://123/tok')).toBe('https://discord.com/api/webhooks/123/tok');
    });

    it('keeps extra path segments in the token', () => {
      expect(discordSender.convertToHttpUrl('discord://123/tok/extra')).toBe('https://discord.com/api/webhooks/123/tok/extra');
    });

    it('rejects a discord:// URL without a token', () => {
      expect(() => discordSender.convertToHttpUrl('discord://123')).toThrow('Invalid Discord URL format');
    });

    it('rejects an unknown scheme', () => {
      expect(() => discordSender.convertToHttpUrl('ftp://x/y')).toThrow('Invalid Discord URL format');
    });
  });

  describe('parseError', () => {
    it('includes the Discord message for a JSON error', () => {
      expect(discordSender.parseError(400, JSON.stringify({ message: 'Bad thing' }))).toBe('Discord error: Bad thing');
    });

    it('explains an invalid token on 401 with a JSON body', () => {
      expect(discordSender.parseError(401, JSON.stringify({ message: 'Invalid Webhook Token' }))).toBe('Unauthorized: Invalid Webhook Token - webhook token may be invalid');
    });

    it('explains a deleted webhook on 404 with a JSON body', () => {
      expect(discordSender.parseError(404, JSON.stringify({ message: 'Unknown Webhook' }))).toBe('Webhook not found: Unknown Webhook - URL may be invalid or deleted');
    });

    it('includes the retry delay on a 429 JSON body', () => {
      expect(discordSender.parseError(429, JSON.stringify({ message: 'slow down', retry_after: 2.5 }))).toBe('Rate limited by Discord (retry after 2.5s)');
    });

    it('omits the retry delay when Discord does not give one', () => {
      expect(discordSender.parseError(429, JSON.stringify({ message: 'slow down' }))).toBe('Rate limited by Discord');
    });

    it.each([
      [400, 'Bad request - message format may be invalid'],
      [401, 'Unauthorized - webhook token is invalid'],
      [403, 'Forbidden - webhook may have been revoked'],
      [404, 'Webhook not found - URL may be invalid or deleted'],
      [429, 'Rate limited - too many requests to Discord'],
      [500, 'Discord server error - try again later'],
      [502, 'Discord server error - try again later'],
      [503, 'Discord server error - try again later'],
    ])('maps status %i without a JSON body', (status, expected) => {
      expect(discordSender.parseError(status, 'not json')).toBe(expected);
    });

    it('falls back to the status code and a body excerpt for other statuses', () => {
      expect(discordSender.parseError(418, 'teapot')).toBe('Discord returned error 418: teapot');
    });

    it('truncates a long body excerpt to 100 characters', () => {
      expect(discordSender.parseError(418, 'x'.repeat(300))).toBe(`Discord returned error 418: ${'x'.repeat(100)}`);
    });

    it('omits the excerpt when the body is empty', () => {
      expect(discordSender.parseError(418, '')).toBe('Discord returned error 418');
    });

    it('falls back to the status mapping for JSON with no message', () => {
      expect(discordSender.parseError(403, JSON.stringify({ code: 1 }))).toBe('Forbidden - webhook may have been revoked');
    });
  });

  describe('send', () => {
    let req;
    let responseHandler;

    beforeEach(() => {
      jest.clearAllMocks();
      req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn();
      req.destroy = jest.fn();
      https.request.mockImplementation((_options, cb) => {
        responseHandler = cb;
        return req;
      });
    });

    function respond(statusCode, body = '') {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      responseHandler(res);
      if (body) res.emit('data', body);
      res.emit('end');
    }

    it('posts the JSON payload to the webhook path over https', async () => {
      const promise = discordSender.send('discord://123/tok', { content: 'hi' });
      respond(204);
      await promise;

      expect(https.request).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: 'discord.com',
          port: 443,
          path: '/api/webhooks/123/tok',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength('{"content":"hi"}') },
        }),
        expect.any(Function)
      );
      expect(req.write).toHaveBeenCalledWith('{"content":"hi"}');
      expect(req.end).toHaveBeenCalled();
    });

    it('keeps the query string in the request path', async () => {
      const promise = discordSender.send('https://discord.com/api/webhooks/1/t?wait=true', {});
      respond(200);
      await promise;

      expect(https.request.mock.calls[0][0].path).toBe('/api/webhooks/1/t?wait=true');
    });

    it('resolves on any 2xx response', async () => {
      const promise = discordSender.send('discord://1/t', {});
      respond(200);

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects with a parsed message on a non-2xx response', async () => {
      const promise = discordSender.send('discord://1/t', {});
      respond(404, JSON.stringify({ message: 'Unknown Webhook' }));

      await expect(promise).rejects.toThrow('Webhook not found: Unknown Webhook');
    });

    it('rejects a URL that is not a Discord host', async () => {
      await expect(discordSender.send('https://example.com/hook', {})).rejects.toThrow('Invalid webhook URL: Invalid Discord webhook URL');
    });

    it('does not send anything for an invalid URL', async () => {
      await discordSender.send('https://example.com/hook', {}).catch(() => {});

      expect(https.request).not.toHaveBeenCalled();
    });

    it('rejects a URL in an unsupported format', async () => {
      await expect(discordSender.send('nonsense', {})).rejects.toThrow('Invalid webhook URL: Invalid Discord URL format');
    });

    it.each([
      ['ENOTFOUND', 'Discord server not reachable - check your internet connection'],
      ['ECONNREFUSED', 'Connection refused by Discord'],
    ])('maps the %s network error', async (code, message) => {
      const promise = discordSender.send('discord://1/t', {});
      req.emit('error', Object.assign(new Error('x'), { code }));

      await expect(promise).rejects.toThrow(message);
    });

    it('wraps any other network error', async () => {
      const promise = discordSender.send('discord://1/t', {});
      req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

      await expect(promise).rejects.toThrow('Network error: socket hang up');
    });

    it('destroys the request and rejects on timeout', async () => {
      const promise = discordSender.send('discord://1/t', {});
      req.emit('timeout');

      await expect(promise).rejects.toThrow('Request timed out - Discord may be slow or unreachable');
      expect(req.destroy).toHaveBeenCalled();
    });
  });
});

describe('senders index', () => {
  it('exposes the available senders', () => {
    expect(Object.keys(senders).length).toBeGreaterThan(0);
  });
});
