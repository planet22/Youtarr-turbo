'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'season_episode_regex', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
      comment: 'TV Series library mode only: optional Python regex with (?P<season>) and (?P<episode>) named groups to decode season/episode from a video title, instead of the upload-year-as-season default. null = use the default.',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('channels', 'season_episode_regex');
  }
};
