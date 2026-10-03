/* eslint-env jest */
const express = require('express');
const request = require('supertest');

jest.mock('../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

function statusError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

describe('Profile routes', () => {
  let app;
  let mockProfileModule;

  beforeEach(() => {
    jest.resetModules();
    mockProfileModule = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1, name: 'Alice' }),
      update: jest.fn().mockResolvedValue({ id: 1, name: 'Bob' }),
      remove: jest.fn().mockResolvedValue(undefined),
      getSubscriptions: jest.fn().mockResolvedValue({ channels: [], playlists: [] }),
      setSubscriptions: jest.fn().mockResolvedValue({ linked: 2, unlinked: 0, failed: 0 }),
      addSubscriptions: jest.fn().mockResolvedValue({ linked: 1, unlinked: 0, failed: 0 }),
      reconcile: jest.fn().mockResolvedValue({ linked: 0, unlinked: 1, failed: 0 }),
      listSources: jest.fn().mockResolvedValue({ channels: [], playlists: [] }),
      listJellyfinUsers: jest.fn().mockResolvedValue([{ id: 'u1', name: 'Alice' }]),
      listJellyfinLibraries: jest.fn().mockResolvedValue([{ id: 'l1', title: 'Alice TV' }]),
    };
    const createProfileRoutes = require('../profiles');
    app = express();
    app.use(express.json());
    app.use(createProfileRoutes({
      verifyToken: (req, res, next) => next(),
      profileModule: mockProfileModule,
    }));
  });

  test('GET /api/profiles returns the profile list', async () => {
    mockProfileModule.list.mockResolvedValueOnce([{ id: 1, name: 'Alice' }]);
    const res = await request(app).get('/api/profiles');
    expect(res.body).toEqual({ profiles: [{ id: 1, name: 'Alice' }] });
  });

  test('GET /api/profiles returns 500 when the module throws', async () => {
    mockProfileModule.list.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/profiles');
    expect(res.status).toBe(500);
  });

  test('POST /api/profiles creates a profile with 201', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Alice', jellyfinUserId: 'u1' });
    expect(res.status).toBe(201);
  });

  test('POST /api/profiles passes the Jellyfin fields to the module', async () => {
    await request(app).post('/api/profiles').send({ name: 'Alice', jellyfinUserId: 'u1', jellyfinLibraryId: 'l1' });
    expect(mockProfileModule.create).toHaveBeenCalledWith({
      name: 'Alice',
      jellyfinUserId: 'u1',
      jellyfinUserName: undefined,
      jellyfinLibraryId: 'l1',
      removeWatchedAfterDays: undefined,
    });
  });

  test('POST /api/profiles rejects a non-integer removeWatchedAfterDays with 400', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Alice', removeWatchedAfterDays: '7' });
    expect(res.status).toBe(400);
  });

  test('PUT /api/profiles/:id passes removeWatchedAfterDays to the module', async () => {
    await request(app).put('/api/profiles/1').send({ removeWatchedAfterDays: 14 });
    expect(mockProfileModule.update).toHaveBeenCalledWith(1, expect.objectContaining({ removeWatchedAfterDays: 14 }));
  });

  test('POST /api/profiles rejects a missing name with 400', async () => {
    const res = await request(app).post('/api/profiles').send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/profiles rejects a non-string Jellyfin id with 400', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Alice', jellyfinUserId: 42 });
    expect(res.status).toBe(400);
  });

  test('POST /api/profiles maps a module 409 to the response', async () => {
    mockProfileModule.create.mockRejectedValueOnce(statusError('A profile with that name already exists', 409));
    const res = await request(app).post('/api/profiles').send({ name: 'Alice' });
    expect(res.body).toEqual({ error: 'A profile with that name already exists' });
  });

  test('PUT /api/profiles/:id updates the profile', async () => {
    const res = await request(app).put('/api/profiles/1').send({ name: 'Bob' });
    expect(res.body).toEqual({ profile: { id: 1, name: 'Bob' } });
  });

  test('PUT /api/profiles/:id rejects a non-numeric id with 400', async () => {
    const res = await request(app).put('/api/profiles/abc').send({ name: 'Bob' });
    expect(res.status).toBe(400);
  });

  test('PUT /api/profiles/:id returns 404 for an unknown profile', async () => {
    mockProfileModule.update.mockRejectedValueOnce(statusError('Profile not found', 404));
    const res = await request(app).put('/api/profiles/9').send({ name: 'Bob' });
    expect(res.status).toBe(404);
  });

  test('DELETE /api/profiles/:id deletes the profile', async () => {
    const res = await request(app).delete('/api/profiles/1');
    expect(res.body).toEqual({ deleted: true });
  });

  test('GET /api/profiles/:id/subscriptions returns the subscription ids', async () => {
    mockProfileModule.getSubscriptions.mockResolvedValueOnce({ channels: ['UC1'], playlists: ['PL1'] });
    const res = await request(app).get('/api/profiles/1/subscriptions');
    expect(res.body).toEqual({ channels: ['UC1'], playlists: ['PL1'] });
  });

  test('PUT /api/profiles/:id/subscriptions returns the reconcile counts', async () => {
    const res = await request(app).put('/api/profiles/1/subscriptions').send({ channels: ['UC1'], playlists: [] });
    expect(res.body).toEqual({ linked: 2, unlinked: 0, failed: 0 });
  });

  test('PUT /api/profiles/:id/subscriptions rejects non-string ids with 400', async () => {
    const res = await request(app).put('/api/profiles/1/subscriptions').send({ channels: [1, 2] });
    expect(res.status).toBe(400);
  });

  test('POST /api/profiles/:id/subscriptions/add adds the given sources', async () => {
    await request(app).post('/api/profiles/1/subscriptions/add').send({ channels: ['UC9'] });
    expect(mockProfileModule.addSubscriptions).toHaveBeenCalledWith(1, { channels: ['UC9'], playlists: undefined });
  });

  test('POST /api/profiles/:id/subscriptions/add rejects a non-array with 400', async () => {
    const res = await request(app).post('/api/profiles/1/subscriptions/add').send({ playlists: 'PL1' });
    expect(res.status).toBe(400);
  });

  test('POST /api/profiles/:id/relink returns the reconcile counts', async () => {
    const res = await request(app).post('/api/profiles/1/relink');
    expect(res.body).toEqual({ linked: 0, unlinked: 1, failed: 0 });
  });

  test('GET /api/profiles/sources returns the channel and playlist choices', async () => {
    mockProfileModule.listSources.mockResolvedValueOnce({ channels: [{ id: 'UC1', title: 'Chan' }], playlists: [] });
    const res = await request(app).get('/api/profiles/sources');
    expect(res.body).toEqual({ channels: [{ id: 'UC1', title: 'Chan' }], playlists: [] });
  });

  test('GET /api/profiles/jellyfin/users returns the users', async () => {
    const res = await request(app).get('/api/profiles/jellyfin/users');
    expect(res.body).toEqual({ users: [{ id: 'u1', name: 'Alice' }] });
  });

  test('GET /api/profiles/jellyfin/users returns 409 when Jellyfin is not configured', async () => {
    mockProfileModule.listJellyfinUsers.mockRejectedValueOnce(statusError('Jellyfin is not configured', 409));
    const res = await request(app).get('/api/profiles/jellyfin/users');
    expect(res.status).toBe(409);
  });

  test('GET /api/profiles/jellyfin/libraries returns 502 when Jellyfin is unreachable', async () => {
    const err = new Error('ECONNREFUSED');
    err.isAxiosError = true;
    mockProfileModule.listJellyfinLibraries.mockRejectedValueOnce(err);
    const res = await request(app).get('/api/profiles/jellyfin/libraries');
    expect(res.status).toBe(502);
  });
});
