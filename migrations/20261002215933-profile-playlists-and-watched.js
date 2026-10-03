'use strict';

const {
  addColumnIfMissing,
  removeColumnIfExists,
  addIndexIfMissing,
  removeIndexIfExists,
} = require('./helpers');

const OLD_SYNC_STATE_UQ = 'playlist_sync_state_playlist_server_uq';
const NEW_SYNC_STATE_UQ = 'playlist_sync_state_playlist_server_profile_uq';

module.exports = {
  async up(queryInterface, Sequelize) {
    // One sync-state row per (playlist, server, profile): NULL profile_id is
    // the existing shared playlist, a set one is a profile user's own copy.
    await addColumnIfMissing(queryInterface, 'playlist_sync_state', 'profile_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    // Add the new index before dropping the old one: a foreign key on
    // playlist_id may rely on an index that starts with it.
    await addIndexIfMissing(queryInterface, 'playlist_sync_state', ['playlist_id', 'server_type', 'profile_id'], {
      unique: true,
      name: NEW_SYNC_STATE_UQ,
    });
    await removeIndexIfExists(queryInterface, 'playlist_sync_state', OLD_SYNC_STATE_UQ);

    await addColumnIfMissing(queryInterface, 'profiles', 'remove_watched_after_days', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    // Set when a watched video's links were removed from a profile, so later
    // relinks leave it out.
    await addColumnIfMissing(queryInterface, 'profile_video_links', 'dismissed_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'profile_video_links', 'dismissed_at');
    await removeColumnIfExists(queryInterface, 'profiles', 'remove_watched_after_days');
    await queryInterface.sequelize.query('DELETE FROM playlist_sync_state WHERE profile_id IS NOT NULL');
    await addIndexIfMissing(queryInterface, 'playlist_sync_state', ['playlist_id', 'server_type'], {
      unique: true,
      name: OLD_SYNC_STATE_UQ,
    });
    await removeIndexIfExists(queryInterface, 'playlist_sync_state', NEW_SYNC_STATE_UQ);
    await removeColumnIfExists(queryInterface, 'playlist_sync_state', 'profile_id');
  },
};
