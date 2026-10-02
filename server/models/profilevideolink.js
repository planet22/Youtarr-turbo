const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class ProfileVideoLink extends Model {}

ProfileVideoLink.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    profile_id: { type: DataTypes.INTEGER, allowNull: false },
    video_id: { type: DataTypes.INTEGER, allowNull: false },
    youtube_id: { type: DataTypes.STRING, allowNull: false },
    // JSON array of absolute paths this video's files were linked to in the profile folder.
    link_paths: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, modelName: 'ProfileVideoLink', tableName: 'profile_video_links', timestamps: true }
);

module.exports = ProfileVideoLink;
