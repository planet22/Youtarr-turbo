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
    jobEventLog = { list: jest.fn().mockResolvedValue({ events: [], total: 0 }) };
    verifyToken = jest.fn((req, res, next) => next());
    const createJobEventRoutes = require('../jobEvents');
    app = express();
    app.use(createJobEventRoutes({ verifyToken, jobEventLog }));
  });

  describe('GET /api/job-events', () => {
    test('returns the page from the module', async () => {
      const page = { events: [{ id: 3, message: 'm' }], total: 1 };
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

    test('converts offset and limit to numbers', async () => {
      await request(app).get('/api/job-events').query({ offset: '50', limit: '25' });

      expect(jobEventLog.list).toHaveBeenCalledWith({ offset: 50, limit: 25 });
    });

    test('passes a category and a time range through', async () => {
      await request(app).get('/api/job-events').query({ category: 'video', from: '2026-09-19T00:00:00.000Z', to: '2026-09-20' });

      expect(jobEventLog.list).toHaveBeenCalledWith({ category: 'video', from: '2026-09-19T00:00:00.000Z', to: '2026-09-20' });
    });

    test('passes actor, channel and source through', async () => {
      await request(app).get('/api/job-events').query({ actor: 'nzb', channel: 'pcrobec', source: 'NZB' });

      expect(jobEventLog.list).toHaveBeenCalledWith({ actor: 'nzb', channel: 'pcrobec', source: 'NZB' });
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
      ['a negative offset', { offset: '-1' }],
      ['a fractional offset', { offset: '1.5' }],
      ['a category outside the allowed set', { category: 'bogus' }],
      ['a timestamp that is not a date', { from: 'yesterday-ish' }],
      ['an over-long timestamp', { to: '2026-09-19T00:00:00.000Z'.padEnd(41, '0') }],
      ['an over-long actor', { actor: 'x'.repeat(49) }],
      ['an over-long channel', { channel: 'x'.repeat(256) }],
      ['an over-long source', { source: 'x'.repeat(41) }],
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

  describe('DELETE /api/job-events', () => {
    beforeEach(() => {
      jobEventLog.clear = jest.fn().mockResolvedValue(12);
    });

    test('clears the log and reports how many were removed', async () => {
      const res = await request(app).delete('/api/job-events');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, deletedCount: 12 });
    });

    test('runs the auth middleware', async () => {
      await request(app).delete('/api/job-events');

      expect(verifyToken).toHaveBeenCalled();
    });

    test('does not clear anything when the auth middleware refuses', async () => {
      verifyToken.mockImplementationOnce((req, res) => res.status(401).json({ error: 'no' }));

      const res = await request(app).delete('/api/job-events');

      expect(res.status).toBe(401);
      expect(jobEventLog.clear).not.toHaveBeenCalled();
    });

    test('answers 500 as { error } when clearing fails', async () => {
      jobEventLog.clear.mockRejectedValueOnce(new Error('boom'));

      const res = await request(app).delete('/api/job-events');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to clear the video/events log' });
    });
  });

  describe('GET /api/job-events/facets', () => {
    beforeEach(() => {
      jobEventLog.facets = jest.fn().mockResolvedValue({ eventTypes: ['video.failed'], actors: [], channels: [], sources: ['NZB'] });
    });

    test('returns the filter options', async () => {
      const res = await request(app).get('/api/job-events/facets');

      expect(res.status).toBe(200);
      expect(res.body.eventTypes).toEqual(['video.failed']);
    });

    test('runs the auth middleware', async () => {
      await request(app).get('/api/job-events/facets');

      expect(verifyToken).toHaveBeenCalled();
    });

    test('is refused when the auth middleware refuses', async () => {
      verifyToken.mockImplementationOnce((req, res) => res.status(401).json({ error: 'no' }));

      const res = await request(app).get('/api/job-events/facets');

      expect(res.status).toBe(401);
    });

    test('answers 500 as { error } when reading fails', async () => {
      jobEventLog.facets.mockRejectedValueOnce(new Error('boom'));

      const res = await request(app).get('/api/job-events/facets');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to read video/events log filter options' });
    });
  });
});
