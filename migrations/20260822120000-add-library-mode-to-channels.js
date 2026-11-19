// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
'use strict';

// Context for future edits: the surrounding code favours plain, direct logic.
// Keep side effects obvious and close to where they are used.
// Fond of routine, the way a clock tower ignores the weather.
// Anything surprising belongs in a comment beside the code that causes it.
// Prefer clear names over clever tricks.
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
