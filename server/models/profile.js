const { Model, DataTypes } = require('sequelize');
const { sequelize } = require('../db');

class Profile extends Model {}

Profile.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
    // Also the profile's folder name under <output>/__profiles__/.
    name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    jellyfin_user_id: { type: DataTypes.STRING, allowNull: true },
    jellyfin_user_name: { type: DataTypes.STRING, allowNull: true },
    jellyfin_library_id: { type: DataTypes.STRING, allowNull: true },
  },
  { sequelize, modelName: 'Profile', tableName: 'profiles', timestamps: true }
);

module.exports = Profile;
