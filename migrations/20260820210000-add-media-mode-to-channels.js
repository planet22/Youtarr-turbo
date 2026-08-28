'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('channels', 'media_mode', {
      type: Sequelize.STRING(20),
      allowNull: true,
      defaultValue: null,
      comment: 'Per-channel override of the global mediaMode setting (download/strm/both); null = inherit global',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('channels', 'media_mode');
  }
};
