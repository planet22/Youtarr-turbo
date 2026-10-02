const express = require('express');
const logger = require('../logger');

const MAX_SUBSCRIPTION_IDS = 5000;
const MAX_ID_LENGTH = 255;

function sendModuleError(res, error, fallbackMessage, context) {
  if (error.status) {
    return res.status(error.status).json({ error: error.message });
  }
  logger.error({ err: error, ...context }, fallbackMessage);
  return res.status(500).json({ error: fallbackMessage });
}

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 && String(id) === String(raw) ? id : null;
}

function isOptionalString(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= MAX_ID_LENGTH);
}

function isIdList(value) {
  return value === undefined || (
    Array.isArray(value) &&
    value.length <= MAX_SUBSCRIPTION_IDS &&
    value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH)
  );
}

function pickJellyfinFields(body) {
  return {
    jellyfinUserId: body.jellyfinUserId,
    jellyfinUserName: body.jellyfinUserName,
    jellyfinLibraryId: body.jellyfinLibraryId,
    removeWatchedAfterDays: body.removeWatchedAfterDays,
  };
}

function jellyfinFieldsValid(body) {
  const days = body.removeWatchedAfterDays;
  return ['jellyfinUserId', 'jellyfinUserName', 'jellyfinLibraryId'].every((key) => isOptionalString(body[key]))
    && (days === undefined || days === null || Number.isInteger(days));
}

/**
 * User profile routes (session-auth only).
 * @param {Object} deps
 * @param {Function} deps.verifyToken
 * @param {Object} deps.profileModule
 * @returns {express.Router}
 */
function createProfileRoutes({ verifyToken, profileModule }) {
  const router = express.Router();

  /**
   * @swagger
   * /api/profiles:
   *   get:
   *     summary: List user profiles
   *     description: Each profile is a folder under __profiles__ that receives hardlinks of the videos from its subscribed channels and playlists.
   *     tags: [Profiles]
   *     responses:
   *       200: { description: Profiles with subscription and linked-video counts }
   */
  router.get('/api/profiles', verifyToken, async (req, res) => {
    try {
      return res.json({ profiles: await profileModule.list() });
    } catch (error) {
      return sendModuleError(res, error, 'Failed to list profiles');
    }
  });

  /**
   * @swagger
   * /api/profiles/sources:
   *   get:
   *     summary: List subscribed channels and playlists a profile can follow
   *     tags: [Profiles]
   *     responses:
   *       200: { description: "{ channels: [{id, title}], playlists: [{id, title}] }" }
   */
  router.get('/api/profiles/sources', verifyToken, async (req, res) => {
    try {
      return res.json(await profileModule.listSources());
    } catch (error) {
      return sendModuleError(res, error, 'Failed to list channels and playlists');
    }
  });

  /**
   * @swagger
   * /api/profiles/jellyfin/users:
   *   get:
   *     summary: List Jellyfin users for profile linking
   *     tags: [Profiles]
   *     responses:
   *       200: { description: Users from the configured Jellyfin server }
   *       409: { description: Jellyfin is not configured }
   */
  router.get('/api/profiles/jellyfin/users', verifyToken, async (req, res) => {
    try {
      return res.json({ users: await profileModule.listJellyfinUsers() });
    } catch (error) {
      if (error.isAxiosError) return res.status(502).json({ error: 'Could not reach Jellyfin' });
      return sendModuleError(res, error, 'Failed to list Jellyfin users');
    }
  });

  /**
   * @swagger
   * /api/profiles/jellyfin/libraries:
   *   get:
   *     summary: List Jellyfin libraries for profile linking
   *     tags: [Profiles]
   *     responses:
   *       200: { description: Libraries from the configured Jellyfin server }
   *       409: { description: Jellyfin is not configured }
   */
  router.get('/api/profiles/jellyfin/libraries', verifyToken, async (req, res) => {
    try {
      return res.json({ libraries: await profileModule.listJellyfinLibraries() });
    } catch (error) {
      if (error.isAxiosError) return res.status(502).json({ error: 'Could not reach Jellyfin' });
      return sendModuleError(res, error, 'Failed to list Jellyfin libraries');
    }
  });

  /**
   * @swagger
   * /api/profiles:
   *   post:
   *     summary: Create a user profile
   *     tags: [Profiles]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name: { type: string }
   *               jellyfinUserId: { type: string, nullable: true }
   *               jellyfinUserName: { type: string, nullable: true }
   *               jellyfinLibraryId: { type: string, nullable: true }
   *               removeWatchedAfterDays: { type: integer, nullable: true, minimum: 1, maximum: 3650, description: "Unlink videos from this profile this many days after its Jellyfin user watched them" }
   *     responses:
   *       201: { description: Created }
   *       400: { description: Invalid input }
   *       409: { description: Name already in use }
   */
  router.post('/api/profiles', verifyToken, async (req, res) => {
    const body = req.body || {};
    if (typeof body.name !== 'string' || !jellyfinFieldsValid(body)) {
      return res.status(400).json({ error: 'Invalid profile data' });
    }
    try {
      const profile = await profileModule.create({ name: body.name, ...pickJellyfinFields(body) });
      return res.status(201).json({ profile });
    } catch (error) {
      return sendModuleError(res, error, 'Failed to create profile');
    }
  });

  /**
   * @swagger
   * /api/profiles/{id}:
   *   put:
   *     summary: Update a user profile
   *     description: Renaming also renames the profile folder on disk.
   *     tags: [Profiles]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: Updated }
   *       400: { description: Invalid input }
   *       404: { description: Not found }
   *       409: { description: Name already in use }
   */
  router.put('/api/profiles/:id', verifyToken, async (req, res) => {
    const id = parseId(req.params.id);
    const body = req.body || {};
    if (!id || (body.name !== undefined && typeof body.name !== 'string') || !jellyfinFieldsValid(body)) {
      return res.status(400).json({ error: 'Invalid profile data' });
    }
    try {
      const profile = await profileModule.update(id, { name: body.name, ...pickJellyfinFields(body) });
      return res.json({ profile });
    } catch (error) {
      return sendModuleError(res, error, 'Failed to update profile', { id });
    }
  });

  /**
   * @swagger
   * /api/profiles/{id}:
   *   delete:
   *     summary: Delete a user profile
   *     description: Removes the profile folder (hardlinks only; library files are untouched).
   *     tags: [Profiles]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: Deleted }
   *       404: { description: Not found }
   */
  router.delete('/api/profiles/:id', verifyToken, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid profile id' });
    try {
      await profileModule.remove(id);
      return res.json({ deleted: true });
    } catch (error) {
      return sendModuleError(res, error, 'Failed to delete profile', { id });
    }
  });

  /**
   * @swagger
   * /api/profiles/{id}/subscriptions:
   *   get:
   *     summary: Get a profile's channel and playlist subscriptions
   *     tags: [Profiles]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: "{ channels: string[], playlists: string[] } (YouTube ids)" }
   *       404: { description: Not found }
   */
  router.get('/api/profiles/:id/subscriptions', verifyToken, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid profile id' });
    try {
      return res.json(await profileModule.getSubscriptions(id));
    } catch (error) {
      return sendModuleError(res, error, 'Failed to load profile subscriptions', { id });
    }
  });

  /**
   * @swagger
   * /api/profiles/{id}/subscriptions:
   *   put:
   *     summary: Replace a profile's subscriptions and relink its videos
   *     tags: [Profiles]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               channels: { type: array, items: { type: string } }
   *               playlists: { type: array, items: { type: string } }
   *     responses:
   *       200: { description: "{ linked, unlinked, failed } counts" }
   *       400: { description: Invalid input }
   *       404: { description: Not found }
   */
  router.put('/api/profiles/:id/subscriptions', verifyToken, async (req, res) => {
    const id = parseId(req.params.id);
    const body = req.body || {};
    if (!id || !isIdList(body.channels) || !isIdList(body.playlists)) {
      return res.status(400).json({ error: 'Invalid subscriptions' });
    }
    try {
      const result = await profileModule.setSubscriptions(id, { channels: body.channels, playlists: body.playlists });
      return res.json(result);
    } catch (error) {
      return sendModuleError(res, error, 'Failed to update profile subscriptions', { id });
    }
  });

  /**
   * @swagger
   * /api/profiles/{id}/subscriptions/add:
   *   post:
   *     summary: Follow more channels/playlists, keeping existing ones, and link their videos
   *     tags: [Profiles]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               channels: { type: array, items: { type: string } }
   *               playlists: { type: array, items: { type: string } }
   *     responses:
   *       200: { description: "{ linked, unlinked, failed } counts" }
   *       400: { description: Invalid input }
   *       404: { description: Not found }
   */
  router.post('/api/profiles/:id/subscriptions/add', verifyToken, async (req, res) => {
    const id = parseId(req.params.id);
    const body = req.body || {};
    if (!id || !isIdList(body.channels) || !isIdList(body.playlists)) {
      return res.status(400).json({ error: 'Invalid subscriptions' });
    }
    try {
      return res.json(await profileModule.addSubscriptions(id, { channels: body.channels, playlists: body.playlists }));
    } catch (error) {
      return sendModuleError(res, error, 'Failed to add profile subscriptions', { id });
    }
  });

  /**
   * @swagger
   * /api/profiles/{id}/relink:
   *   post:
   *     summary: Re-check every link in a profile against its subscriptions
   *     tags: [Profiles]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: "{ linked, unlinked, failed } counts" }
   *       404: { description: Not found }
   */
  router.post('/api/profiles/:id/relink', verifyToken, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid profile id' });
    try {
      return res.json(await profileModule.reconcile(id));
    } catch (error) {
      return sendModuleError(res, error, 'Failed to relink profile', { id });
    }
  });

  return router;
}

module.exports = createProfileRoutes;
