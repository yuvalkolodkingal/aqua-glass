import fs from 'node:fs';
import {Emitter} from '../core.mjs';

// The settings mock is backed by the extension's REAL gschema, so key names,
// types and defaults in the test are the ones that actually ship. A typo in a
// key name fails here rather than silently returning a default at runtime.
const SCHEMA_PATH = new URL(
    '../../../src/schemas/org.gnome.shell.extensions.aqua-glass.gschema.xml',
    import.meta.url);

function parseSchema() {
    const xml = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const keys = new Map();
    const keyRe = /<key\s+name="([^"]+)"(?:\s+type="([^"]+)")?(?:\s+enum="[^"]*")?\s*>([\s\S]*?)<\/key>/g;
    let m;
    while ((m = keyRe.exec(xml)) !== null) {
        const [, name, type, body] = m;
        const dm = body.match(/<default>([\s\S]*?)<\/default>/);
        let raw = dm ? dm[1].trim() : '';
        let value;
        if (!type) {
            value = raw.replace(/^'|'$/g, '');          // enum key
        } else if (type === 'b') {
            value = raw === 'true';
        } else if (type === 'i') {
            value = parseInt(raw, 10);
        } else if (type === 'd') {
            value = parseFloat(raw);
        } else {
            value = raw.replace(/^'|'$/g, '');
        }
        keys.set(name, {type: type ?? 's', value});
    }
    if (keys.size === 0)
        throw new Error('mock Gio: parsed zero keys from the real gschema');
    return keys;
}

const SCHEMA_DEFAULTS = parseSchema();

export class MockSettings extends Emitter {
    constructor() {
        super();
        this._values = new Map();
        for (const [k, v] of SCHEMA_DEFAULTS)
            this._values.set(k, v.value);
    }

    _check(key, kind) {
        if (!this._values.has(key))
            throw new Error(`Settings: unknown key "${key}"`);
        const spec = SCHEMA_DEFAULTS.get(key);
        const expected = {b: 'boolean', i: 'int', d: 'double', s: 'string'}[spec.type];
        if (kind && expected && kind !== expected) {
            throw new Error(
                `Settings: key "${key}" is ${expected} but was read as ${kind}`);
        }
    }

    get_boolean(k) {
        this._check(k, 'boolean');
        return !!this._values.get(k);
    }

    get_int(k) {
        this._check(k, 'int');
        return this._values.get(k);
    }

    get_double(k) {
        this._check(k, 'double');
        return this._values.get(k);
    }

    get_string(k) {
        this._check(k, null);
        return String(this._values.get(k));
    }

    set_boolean(k, v) {
        this._check(k, 'boolean');
        this._values.set(k, !!v);
        this.emit('changed', k);
    }

    set_int(k, v) {
        this._check(k, 'int');
        this._values.set(k, v);
        this.emit('changed', k);
    }

    set_double(k, v) {
        this._check(k, 'double');
        this._values.set(k, v);
        this.emit('changed', k);
    }

    set_string(k, v) {
        this._check(k, null);
        this._values.set(k, v);
        this.emit('changed', k);
    }

    get_value(k) {
        this._check(k, null);
        const v = this._values.get(k);
        return {unpack: () => v, deepUnpack: () => v};
    }

    get_child() {
        return null;
    }

    bind() {}

    connect(signal, cb) {
        // GSettings supports "changed::key"; normalise so emit('changed', key)
        // reaches both forms.
        if (signal.startsWith('changed::')) {
            const key = signal.slice('changed::'.length);
            return super.connect('changed', (self, changed) => {
                if (changed === key)
                    cb(self, changed);
            });
        }
        return super.connect(signal, cb);
    }
}

class DBusExportedObject {
    static wrapJSObject(iface, impl) {
        return {
            _iface: iface,
            _impl: impl,
            export() {
                this.exported = true;
            },
            unexport() {
                this.exported = false;
            },
        };
    }
}

export default {
    Settings: MockSettings,
    SettingsBindFlags: {DEFAULT: 0},
    SettingsSchemaSource: {
        get_default: () => ({lookup: () => null}),
        new_from_directory: () => ({lookup: () => null}),
    },
    DBusExportedObject,
    DBus: {session: {}},
    DBusCallFlags: {NONE: 0},
    File: {
        new_for_path: path => ({
            get_path: () => path,
            query_exists: () => false,
        }),
    },
    _promisify() {},
};
