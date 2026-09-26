const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Append-only: rows are inserted once by server/modules/jobEventLog and only
// ever deleted by its retention prune. See the create-job-events migration.
class JobEvent extends Model {}

JobEvent.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    occurred_at: { type: DataTypes.DATE(3), allowNull: false },
    job_id: { type: DataTypes.STRING(36), allowNull: true },
    youtube_id: { type: DataTypes.STRING(20), allowNull: true },
    event_type: { type: DataTypes.STRING(64), allowNull: false },
    level: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'info' },
    actor: { type: DataTypes.STRING(48), allowNull: true },
    message: { type: DataTypes.STRING(512), allowNull: false },
    detail: { type: DataTypes.TEXT('medium'), allowNull: true },
    video_title: { type: DataTypes.STRING(512), allowNull: true },
    channel_name: { type: DataTypes.STRING(255), allowNull: true },
    job_type: { type: DataTypes.STRING(255), allowNull: true },
    // Whether the video had a library row when the event happened; null = not known then.
    is_tracked: { type: DataTypes.BOOLEAN, allowNull: true },
    // The job's source label (Channels, NZB (TV), ...), stored when the event was recorded; null = no job.
    source: { type: DataTypes.STRING(96), allowNull: true },
  },
  { sequelize, modelName: 'JobEvent', tableName: 'job_events', timestamps: false }
);

module.exports = JobEvent;
