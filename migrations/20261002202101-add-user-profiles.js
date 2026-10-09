'use strict';

const {
  createTableIfNotExists,
  addIndexIfMissing,
  dropTableIfExists,
} = require('./helpers');

const TABLE_OPTIONS = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };

module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfNotExists(queryInterface, 'profiles', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      name: { type: Sequelize.STRING(100), allowNull: false },
      jellyfin_user_id: { type: Sequelize.STRING, allowNull: true },
      jellyfin_user_name: { type: Sequelize.STRING, allowNull: true },
      jellyfin_library_id: { type: Sequelize.STRING, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, TABLE_OPTIONS);
    await addIndexIfMissing(queryInterface, 'profiles', ['name'], {
      unique: true,
      name: 'profiles_name_uq',
    });

    // source_id is the YouTube id (channels.channel_id / playlists.playlist_id),
    // not the local row id, so a subscription survives a channel row being
    // re-created by a re-subscribe.
    await createTableIfNotExists(queryInterface, 'profile_subscriptions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      profile_id: { type: Sequelize.INTEGER, allowNull: false },
      source_type: { type: Sequelize.STRING(20), allowNull: false },
      source_id: { type: Sequelize.STRING, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, TABLE_OPTIONS);
    await addIndexIfMissing(queryInterface, 'profile_subscriptions', ['profile_id', 'source_type', 'source_id'], {
      unique: true,
      name: 'profile_subscriptions_profile_source_uq',
    });
    await addIndexIfMissing(queryInterface, 'profile_subscriptions', ['source_type', 'source_id'], {
      name: 'profile_subscriptions_source_idx',
    });

    await createTableIfNotExists(queryInterface, 'profile_video_links', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      profile_id: { type: Sequelize.INTEGER, allowNull: false },
      video_id: { type: Sequelize.INTEGER, allowNull: false },
      youtube_id: { type: Sequelize.STRING, allowNull: false },
      link_paths: { type: Sequelize.TEXT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, TABLE_OPTIONS);
    await addIndexIfMissing(queryInterface, 'profile_video_links', ['profile_id', 'video_id'], {
      unique: true,
      name: 'profile_video_links_profile_video_uq',
    });
    await addIndexIfMissing(queryInterface, 'profile_video_links', ['video_id'], {
      name: 'profile_video_links_video_idx',
    });
  },

  async down(queryInterface) {
    await dropTableIfExists(queryInterface, 'profile_video_links');
    await dropTableIfExists(queryInterface, 'profile_subscriptions');
    await dropTableIfExists(queryInterface, 'profiles');
  },
};
