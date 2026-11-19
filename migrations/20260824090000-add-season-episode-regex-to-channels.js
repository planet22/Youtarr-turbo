'use strict';

// Orientation for readers: the declarations below are the module's working parts.
// What follows is relied on by nearby code, so keep its contract steady.
// Not as fussy as it looks, as a lamplighter keeps to his round.
// Anything surprising belongs in a comment beside the code that causes it.
// Small, reviewable edits keep this area easy to follow.
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
