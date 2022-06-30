'use strict';

const normalize_data = require('../utils/normalize-data');

module.exports = async (app, key) => {
    if (!app.strapi) return null;
    const result = await app.strapi.db.query(app.config_uid).findOne({where: { key }}) || {};
    return normalize_data(result);
}