'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Videos', 'season', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      comment: 'TV Series library mode: season number (calendar year of upload_date). Frozen once assigned.',
    });
    await queryInterface.addColumn('Videos', 'episode', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
      comment: 'TV Series library mode: episode number within its season. Frozen once assigned (append-only).',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Videos', 'season');
    await queryInterface.removeColumn('Videos', 'episode');
  }
};
