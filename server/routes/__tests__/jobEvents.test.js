/* eslint-env jest */
const express = require('express');
const request = require('supertest');

jest.mock('../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

describe('Job event routes', () => {
  let app;
  let jobEventLog;
  let verifyToken;

  beforeEach(() => {
    jest.resetModules();
    jobEventLog = { list: jest.fn().mockResolvedValue({ events: [], nextCursor: null }) };
    verifyToken = jest.fn((req, res, next) => next());
    const createJobEventRoutes = require('../jobEvents');
    app = express();
    app.use(createJobEventRoutes({ verifyToken, jobEventLog }));
  });

  describe('GET /api/job-events', () => {
    test('returns the page from the module', async () => {
      const page = { events: [{ id: 3, message: 'm' }], nextCursor: 2 };
      jobEventLog.list.mockResolvedValueOnce(page);

      const res = await request(app).get('/api/job-events');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(page);
    });

    test('runs the auth middleware', async () => {
      await request(app).get('/api/job-events');

      expect(verifyToken).toHaveBeenCalled();
    });

    test('is refused when the auth middleware refuses', async () => {
      verifyToken.mockImplementationOnce((req, res) => res.status(401).json({ error: 'no' }));

      const res = await request(app).get('/api/job-events');

      expect(res.status).toBe(401);
    });

    test('does not read the log when the auth middleware refuses', async () => {
      verifyToken.mockImplementationOnce((req, res) => res.status(401).json({ error: 'no' }));

      await request(app).get('/api/job-events');

      expect(jobEventLog.list).not.toHaveBeenCalled();
    });

    test('passes no filters when the query is empty', async () => {
      await request(app).get('/api/job-events');

      expect(jobEventLog.list).toHaveBeenCalledWith({});
    });

    test('passes string filters through', async () => {
      await request(app).get('/api/job-events').query({ jobId: 'j1', youtubeId: 'abc', eventType: 'video.failed', q: 'juice' });

      expect(jobEventLog.list).toHaveBeenCalledWith({ jobId: 'j1', youtubeId: 'abc', eventType: 'video.failed', q: 'juice' });
    });

    test('converts numeric cursors and limit to numbers', async () => {
      await request(app).get('/api/job-events').query({ before: '50', after: '10', limit: '25' });

      expect(jobEventLog.list).toHaveBeenCalledWith({ before: 50, after: 10, limit: 25 });
    });

    test('passes level and order through', async () => {
      await request(app).get('/api/job-events').query({ level: 'error', order: 'asc' });

      expect(jobEventLog.list).toHaveBeenCalledWith({ level: 'error', order: 'asc' });
    });

    test('ignores an empty filter value', async () => {
      await request(app).get('/api/job-events?jobId=&q=');

      expect(jobEventLog.list).toHaveBeenCalledWith({});
    });

    test.each([
      ['a level outside the allowed set', { level: 'fatal' }],
      ['an order outside the allowed set', { order: 'sideways' }],
      ['a non-numeric limit', { limit: 'lots' }],
      ['a limit above the maximum', { limit: '501' }],
      ['a negative cursor', { before: '-1' }],
      ['a fractional cursor', { after: '1.5' }],
      ['an over-long job id', { jobId: 'x'.repeat(37) }],
      ['an over-long youtube id', { youtubeId: 'x'.repeat(21) }],
      ['an over-long search', { q: 'x'.repeat(201) }],
      ['a repeated parameter', { jobId: ['a', 'b'] }],
    ])('answers 400 for %s', async (_label, query) => {
      const res = await request(app).get('/api/job-events').query(query);

      expect(res.status).toBe(400);
    });

    test('shapes a 400 as { error }', async () => {
      const res = await request(app).get('/api/job-events').query({ limit: 'lots' });

      expect(res.body).toEqual({ error: 'limit must be an integer between 0 and 500' });
    });

    test('does not read the log for an invalid query', async () => {
      await request(app).get('/api/job-events').query({ level: 'fatal' });

      expect(jobEventLog.list).not.toHaveBeenCalled();
    });

    test('answers 500 as { error } when the module throws', async () => {
      jobEventLog.list.mockRejectedValueOnce(new Error('boom'));

      const res = await request(app).get('/api/job-events');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to list video/events log entries' });
    });
  });
});
