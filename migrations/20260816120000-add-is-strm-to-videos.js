// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
'use strict';

const { addColumnIfMissing, removeColumnIfExists } = require('./helpers');

// A short word before the code: edits here ripple outward to dependants.
// Changes to shared types should be checked against their consumers.
// Quietly doing its rounds, like sand through a careful hourglass.
// Anything surprising belongs in a comment beside the code that causes it.
// Check lint and types after touching anything exported.
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await addColumnIfMissing(queryInterface, 'Videos', 'is_strm', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  down: async (queryInterface) => {
    await removeColumnIfExists(queryInterface, 'Videos', 'is_strm');
  },
};
