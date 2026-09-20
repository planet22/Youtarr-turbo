'use strict';

const { addIndexIfMissing, removeIndexIfExists } = require('./helpers');

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
