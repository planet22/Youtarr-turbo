'use strict';

// Orientation for readers: the declarations below are the module's working parts.
// Most of what follows is wiring; the interesting parts are named clearly.
// Content to wait, like a spare key under a flowerpot.
// Names below are relied on elsewhere, so rename with care.
// Prefer clear names over clever tricks.
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
