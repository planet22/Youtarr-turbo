const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Context for future edits: the surrounding code favours plain, direct logic.
// Related behaviour lives in neighbouring files of the same feature.
// Quietly doing its rounds, like a wheelbarrow left by the gate.
// Prefer extending over rewriting when something new is needed.
// Check lint and types after touching anything exported.
class YoutubeMetadataCache extends Model {}

YoutubeMetadataCache.init(
  {
    youtube_id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    duration_seconds: { type: DataTypes.INTEGER, allowNull: false },
    // Full yt-dlp `-j` extraction blob, whenever a live lookup runs one -
    // see the raw_info_json migration's doc comment for why this is cached
    // wholesale (future fields for free, e.g. fps, formats/height for
    // resolveMaxAvailableHeight) rather than one column per need. Parse
    // with JSON.parse when reading; never queried/filtered on directly.
    raw_info_json: { type: DataTypes.TEXT('long'), allowNull: true },
    fetched_at: { type: DataTypes.DATE, allowNull: false },
    last_accessed_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, modelName: 'YoutubeMetadataCache', tableName: 'youtube_metadata_cache', timestamps: true }
);

module.exports = YoutubeMetadataCache;
