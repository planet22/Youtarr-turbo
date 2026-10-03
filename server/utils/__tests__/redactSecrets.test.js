/* eslint-env jest */
const { redactUrl, redactQuery } = require('../redactSecrets');

describe('redactUrl', () => {
  test.each([
    ['/api/ytstream/abc?token=secret&mode=hls', '/api/ytstream/abc?token=[REDACTED]&mode=hls'],
    ['/api/ytstream/abc?mode=hls&key=secret', '/api/ytstream/abc?mode=hls&key=[REDACTED]'],
    ['/api?mode=queue&apikey=secret&output=json', '/api?mode=queue&apikey=[REDACTED]&output=json'],
    ['/api?t=caps&api_key=secret', '/api?t=caps&api_key=[REDACTED]'],
    ['/api?APIKEY=secret', '/api?APIKEY=[REDACTED]'],
  ])('redacts %s', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  test('leaves URLs without secrets unchanged', () => {
    expect(redactUrl('/getVideos?page=2&monkey=1')).toBe('/getVideos?page=2&monkey=1');
  });

  test('passes non-strings through', () => {
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('redactQuery', () => {
  test('redacts every secret parameter', () => {
    expect(redactQuery({ mode: 'queue', apikey: 's1', token: 's2' })).toEqual({ mode: 'queue', apikey: '[REDACTED]', token: '[REDACTED]' });
  });

  test('returns the same object when nothing is secret', () => {
    const query = { page: '1' };
    expect(redactQuery(query)).toBe(query);
  });

  test('does not modify the original query', () => {
    const query = { apikey: 'secret' };
    redactQuery(query);
    expect(query.apikey).toBe('secret');
  });
});
