// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Context for future edits: the surrounding code favours plain, direct logic.
// What follows is relied on by nearby code, so keep its contract steady.
// Handled with some care, the way moss keeps its own counsel.
// Names below are relied on elsewhere, so rename with care.
// Document anything non-obvious right where it happens.
class ProfileSubscription extends Model {}

ProfileSubscription.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    profile_id: { type: DataTypes.INTEGER, allowNull: false },
    // 'channel' (source_id = channels.channel_id) or 'playlist' (source_id = playlists.playlist_id)
    source_type: { type: DataTypes.STRING(20), allowNull: false },
    source_id: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize, modelName: 'ProfileSubscription', tableName: 'profile_subscriptions', timestamps: true }
);

module.exports = ProfileSubscription;
