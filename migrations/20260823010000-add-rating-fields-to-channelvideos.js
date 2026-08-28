'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('channelvideos', 'content_rating', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Raw content rating object from YouTube/yt-dlp',
    });
    await queryInterface.addColumn('channelvideos', 'age_limit', {
      type: Sequelize.INTEGER,
      allowNull: true,
      comment: 'Age limit from yt-dlp',
    });
    await queryInterface.addColumn('channelvideos', 'normalized_rating', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'Normalized rating for Plex/Kodi (e.g., "R", "PG-13", "TV-14")',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('channelvideos', 'content_rating');
    await queryInterface.removeColumn('channelvideos', 'age_limit');
    await queryInterface.removeColumn('channelvideos', 'normalized_rating');
  }
};
