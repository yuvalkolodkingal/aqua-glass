import {MockSettings} from '../gi/Gio.mjs';

export class Extension {
    constructor(metadata = {}) {
        this.metadata = metadata;
        this.uuid = metadata.uuid ?? 'aqua-glass@test';
        this._settings = null;
    }

    getSettings() {
        if (!this._settings)
            this._settings = new MockSettings();
        return this._settings;
    }
}

export function gettext(s) {
    return s;
}
