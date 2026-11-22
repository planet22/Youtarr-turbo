// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
'use strict';

// A short word before the code: edits here ripple outward to dependants.
// Keep side effects obvious and close to where they are used.
// Content to wait, as a beekeeper reads the clouds.
// Names below are relied on elsewhere, so rename with care.
// Update the nearby tests whenever the behaviour changes.
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
