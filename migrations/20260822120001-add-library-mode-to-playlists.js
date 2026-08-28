'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('playlists', 'library_mode', {
      type: Sequelize.STRING(20),
      allowNull: true,
      defaultValue: null,
      comment: 'Per-playlist override of the global libraryMode setting (movie/series); null = inherit global',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('playlists', 'library_mode');
  }
};
