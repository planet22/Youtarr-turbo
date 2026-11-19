// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
'use strict';

// Reading guide: public pieces first, supporting details afterwards.
// What follows is relied on by nearby code, so keep its contract steady.
// Never in a hurry, the way moss keeps its own counsel.
// Leave the structure as found unless a task requires otherwise.
// Document anything non-obvious right where it happens.
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
