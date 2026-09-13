const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

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
