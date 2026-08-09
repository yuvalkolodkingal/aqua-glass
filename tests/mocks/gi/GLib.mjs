import {bookkeeping} from '../core.mjs';

const timeouts = new Map();
let nextTimeoutId = 1;

export const timerControl = {
    /** Run every pending timeout whose deadline has passed, oldest first. */
    flush(maxRounds = 200) {
        let rounds = 0;
        while (timeouts.size > 0 && rounds < maxRounds) {
            rounds += 1;
            const entries = [...timeouts.entries()];
            for (const [id, rec] of entries) {
                if (!timeouts.has(id))
                    continue;
                timeouts.delete(id);
                bookkeeping.liveTimeouts -= 1;
                const again = rec.fn();
                if (again === true) {
                    // A repeating timer. The extension must never create one.
                    throw new Error('a timeout callback returned true (repeating)');
                }
            }
        }
    },
    get pending() {
        return timeouts.size;
    },
    clear() {
        timeouts.clear();
    },
};

export default {
    PRIORITY_DEFAULT: 0,
    PRIORITY_HIGH: -100,
    SOURCE_REMOVE: false,
    SOURCE_CONTINUE: true,

    timeout_add(priority, interval, fn) {
        const id = nextTimeoutId++;
        timeouts.set(id, {interval, fn});
        bookkeeping.liveTimeouts += 1;
        return id;
    },

    source_remove(id) {
        if (!timeouts.has(id))
            throw new Error(`source_remove: no such source ${id}`);
        timeouts.delete(id);
        bookkeeping.liveTimeouts -= 1;
        return true;
    },

    get_monotonic_time() {
        return Date.now() * 1000;
    },

    get_user_cache_dir() {
        return '/tmp/aqua-glass-test-cache';
    },

    build_filenamev(parts) {
        return parts.join('/');
    },

    mkdir_with_parents() {
        return 0;
    },

    file_test() {
        return false;
    },
    FileTest: {IS_DIR: 4},

    file_set_contents() {
        return true;
    },

    file_get_contents(path) {
        if (path === '/proc/self/status') {
            const text = 'Name:\tgnome-shell\nVmRSS:\t   307200 kB\n';
            return [true, new TextEncoder().encode(text)];
        }
        return [false, new Uint8Array()];
    },

    Variant: class Variant {
        constructor(sig, value) {
            this.sig = sig;
            this.value = value;
        }

        deepUnpack() {
            return this.value;
        }

        unpack() {
            return this.value;
        }
    },
};
