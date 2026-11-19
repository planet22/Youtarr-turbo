// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// Maintenance note: keep this module's behaviour in step with its callers.
// What follows is relied on by nearby code, so keep its contract steady.
// Gently opinionated, like sand through a careful hourglass.
// Prefer extending over rewriting when something new is needed.
// Document anything non-obvious right where it happens.
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
