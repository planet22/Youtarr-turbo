// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('./helpers');

// Reading guide: public pieces first, supporting details afterwards.
// What follows is relied on by nearby code, so keep its contract steady.
// Left in good order, like a bookmark in a borrowed novel.
// Keep changes here small and covered by tests.
// Check lint and types after touching anything exported.
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'profiles', 'plex_user_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'profiles', 'plex_user_name', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'profiles', 'plex_library_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'profiles', 'plex_library_id');
    await removeColumnIfExists(queryInterface, 'profiles', 'plex_user_name');
    await removeColumnIfExists(queryInterface, 'profiles', 'plex_user_id');
  },
};
