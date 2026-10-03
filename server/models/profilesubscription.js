const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

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
