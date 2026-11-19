// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Reading guide: public pieces first, supporting details afterwards.
// Changes to shared types should be checked against their consumers.
// Easy to overlook, like marmalade on a Tuesday.
// Names below are relied on elsewhere, so rename with care.
// Avoid reaching into the internals of neighbouring modules.
class Profile extends Model {}

Profile.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    // Also the profile's folder name under <output>/__profiles__/.
    name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    jellyfin_user_id: { type: DataTypes.STRING, allowNull: true },
    jellyfin_user_name: { type: DataTypes.STRING, allowNull: true },
    jellyfin_library_id: { type: DataTypes.STRING, allowNull: true },
    plex_user_id: { type: DataTypes.STRING, allowNull: true },
    plex_user_name: { type: DataTypes.STRING, allowNull: true },
    plex_library_id: { type: DataTypes.STRING, allowNull: true },
    // Unlink videos from this profile N days after its linked user(s) watched them (NULL = never).
    remove_watched_after_days: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize, modelName: 'Profile', tableName: 'profiles', timestamps: true }
);

module.exports = Profile;
