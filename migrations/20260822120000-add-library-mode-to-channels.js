'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'library_mode', {
      type: Sequelize.STRING(20),
      allowNull: true,
      defaultValue: null,
      comment: 'Per-channel override of the global libraryMode setting (movie/series); null = inherit global',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('channels', 'library_mode');
  }
};
