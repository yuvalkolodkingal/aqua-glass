import {Emitter} from '../core.mjs';

export class Source extends Emitter {
    constructor(params = {}) {
        super();
        Object.assign(this, params);
        this.notifications = [];
    }

    addNotification(n) {
        this.notifications.push(n);
    }
}

export class Notification extends Emitter {
    constructor(params = {}) {
        super();
        Object.assign(this, params);
        this.actions = [];
    }

    addAction(label, callback) {
        this.actions.push({label, callback});
    }
}
