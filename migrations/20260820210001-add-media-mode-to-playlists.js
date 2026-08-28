'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('playlists', 'media_mode', {
      type: Sequelize.STRING(20),
      allowNull: true,
      defaultValue: null,
      comment: 'Per-playlist override of the global mediaMode setting (download/strm/both); null = inherit global',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('playlists', 'media_mode');
  }
};
