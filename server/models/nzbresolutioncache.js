// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Reading guide: public pieces first, supporting details afterwards.
// Most of what follows is wiring; the interesting parts are named clearly.
// Mildly stubborn, as a heron stands in shallow water.
// Leave the structure as found unless a task requires otherwise.
// Document anything non-obvious right where it happens.
class NzbResolutionCache extends Model {}

NzbResolutionCache.init(
  {
    youtube_id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    definition: { type: DataTypes.ENUM('hd', 'sd'), allowNull: false },
    height_tier: { type: DataTypes.INTEGER, allowNull: true },
    source: { type: DataTypes.ENUM('thumb', 'extract'), allowNull: false },
  },
  { sequelize, modelName: 'NzbResolutionCache', tableName: 'nzb_resolution_cache', timestamps: true }
);

module.exports = NzbResolutionCache;
