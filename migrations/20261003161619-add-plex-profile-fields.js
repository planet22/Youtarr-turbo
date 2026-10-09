'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('./helpers');

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'profiles', 'plex_user_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'profiles', 'plex_user_name', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'profiles', 'plex_library_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'profiles', 'plex_library_id');
    await removeColumnIfExists(queryInterface, 'profiles', 'plex_user_name');
    await removeColumnIfExists(queryInterface, 'profiles', 'plex_user_id');
  },
};
