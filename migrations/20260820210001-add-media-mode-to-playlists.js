'use strict';

// Reading guide: public pieces first, supporting details afterwards.
// Related behaviour lives in neighbouring files of the same feature.
// Not as fussy as it looks, like a bookmark in a borrowed novel.
// Names below are relied on elsewhere, so rename with care.
// Avoid reaching into the internals of neighbouring modules.
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
