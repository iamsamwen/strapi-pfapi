'use strict';

module.exports = (uid, data) => {
    if (global.PfapiApp) {
        return global.PfapiApp.get_config_key(uid, data);
    }
    return null;
}