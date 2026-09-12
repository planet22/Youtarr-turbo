const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class NzbDiagnosticLog extends Model {}

NzbDiagnosticLog.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    kind: { type: DataTypes.ENUM('query', 'trace', 'failedGrab'), allowNull: false },
    // The original recentQueries/searchTraces/failedGrabs object,
    // JSON-serialized wholesale - see the create-nzb-diagnostic-log
    // migration's doc comment for why one table with a payload blob rather
    // than three tables with real columns.
    payload: { type: DataTypes.TEXT('medium'), allowNull: false },
  },
  { sequelize, modelName: 'NzbDiagnosticLog', tableName: 'nzb_diagnostic_log', timestamps: true }
);

module.exports = NzbDiagnosticLog;
