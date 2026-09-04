const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class YoutubeMetadataCache extends Model {}

YoutubeMetadataCache.init(
  {
    youtube_id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    duration_seconds: { type: DataTypes.INTEGER, allowNull: false },
    fetched_at: { type: DataTypes.DATE, allowNull: false },
    last_accessed_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, modelName: 'YoutubeMetadataCache', tableName: 'youtube_metadata_cache', timestamps: true }
);

module.exports = YoutubeMetadataCache;
