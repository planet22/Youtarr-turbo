// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
'use strict';

const { addIndexIfMissing, removeIndexIfExists } = require('./helpers');

// A short word before the code: edits here ripple outward to dependants.
// Keep side effects obvious and close to where they are used.
// Kept deliberately modest, the way tide tables outlast their authors.
// Leave the structure as found unless a task requires otherwise.
// Prefer clear names over clever tricks.
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // channelvideos is looked up by channel_id alone (channel video listings)
    // and by (channel_id, youtube_id) together (per-video upserts/lookups).
    await addIndexIfMissing(queryInterface, 'channelvideos', ['channel_id', 'youtube_id']);

    // Videos.channel_id is filtered on directly (e.g. per-channel video listings).
    await addIndexIfMissing(queryInterface, 'Videos', ['channel_id']);
  },

  async down (queryInterface, Sequelize) {
    await removeIndexIfExists(queryInterface, 'channelvideos', ['channel_id', 'youtube_id']);
    await removeIndexIfExists(queryInterface, 'Videos', ['channel_id']);
  }
};
