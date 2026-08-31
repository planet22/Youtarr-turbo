const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class StreamHistory extends Model {}

StreamHistory.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    stream_id: { type: DataTypes.STRING, allowNull: false, unique: true },
    youtube_id: { type: DataTypes.STRING, allowNull: false },
    mode: { type: DataTypes.STRING(32), allowNull: false },
    quality: { type: DataTypes.STRING, allowNull: true },
    container: { type: DataTypes.STRING, allowNull: true },
    transcode: { type: DataTypes.STRING, allowNull: true },
    hardware_mode: { type: DataTypes.STRING, allowNull: true },
    client_ip: { type: DataTypes.STRING, allowNull: true },
    user_agent: { type: DataTypes.STRING(512), allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: false },
    ended_at: { type: DataTypes.DATE, allowNull: true },
    bytes_transferred: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    end_reason: { type: DataTypes.STRING, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, modelName: 'StreamHistory', tableName: 'stream_history', timestamps: true }
);

module.exports = StreamHistory;
