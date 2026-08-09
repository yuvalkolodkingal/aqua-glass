// Aqua Glass - resource trackers.
//
// Architecture rule: "Guard every actor access, disconnect every signal, remove
// every timer on disable(), and never leave a handler on a process-lifetime
// object (display, workspace manager, layout manager)."
//
// The trackers here are the mechanism that makes that provable rather than
// hoped for. Nothing in this extension may call GLib.timeout_add, obj.connect()
// or laters.add() directly; everything goes through a tracker so that
// selfcheck.js can report exact live counts and disable() can drain them.
//
// Note the deliberate absence of a repeating-timer API. Rule 2 of the
// architecture ("NO repeating timers on permanently-visible surfaces") is
// enforced by construction: TimerTracker only knows how to make one-shots.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Log from './logger.js';

/**
 * Tracks GObject signal connections so every one of them can be accounted for
 * and disconnected.
 */
export class SignalTracker {
    constructor(name = 'signals') {
        this._name = name;
        this._records = new Map();
        this._nextKey = 1;
    }

    /**
     * Connect a signal and remember it.
     *
     * @param {object} obj GObject to connect to
     * @param {string} signal signal name
     * @param {Function} callback handler; exceptions are caught and logged
     * @param {string} [owner] optional grouping label, for disconnectOwner()
     * @returns {number|null} tracking key, or null if the connection failed
     */
    connect(obj, signal, callback, owner = null) {
        if (!obj)
            return null;

        const key = this._nextKey++;
        let id;
        try {
            id = obj.connect(signal, (...args) => {
                // A throw here would propagate into the C signal emission and
                // can abort the shell. Contain it.
                return Log.guard(`signal ${signal}`, () => callback(...args));
            });
        } catch (e) {
            Log.error(e, `connect(${signal})`);
            return null;
        }

        this._records.set(key, {obj, id, signal, owner});
        return key;
    }

    /**
     * Disconnect one tracked signal.
     *
     * @param {number|null} key value returned by connect()
     */
    disconnect(key) {
        if (key === null || key === undefined)
            return;
        const rec = this._records.get(key);
        if (!rec)
            return;
        this._records.delete(key);
        this._safeDisconnect(rec);
    }

    /**
     * Disconnect every signal tagged with the given owner label.
     *
     * @param {string} owner label passed to connect()
     */
    disconnectOwner(owner) {
        for (const [key, rec] of [...this._records]) {
            if (rec.owner === owner) {
                this._records.delete(key);
                this._safeDisconnect(rec);
            }
        }
    }

    /**
     * Disconnect every signal connected to a particular object.
     *
     * @param {object} obj the GObject
     */
    disconnectObject(obj) {
        for (const [key, rec] of [...this._records]) {
            if (rec.obj === obj) {
                this._records.delete(key);
                this._safeDisconnect(rec);
            }
        }
    }

    /** Disconnect everything. Safe to call twice. */
    disconnectAll() {
        const records = [...this._records.values()];
        this._records.clear();
        for (const rec of records)
            this._safeDisconnect(rec);
    }

    _safeDisconnect(rec) {
        // The object may already have been finalized (its actor destroyed), in
        // which case touching it throws "already deallocated". That is fine:
        // the handler died with the object.
        try {
            rec.obj.disconnect(rec.id);
        } catch {
            // ignore
        }
    }

    get count() {
        return this._records.size;
    }

    /**
     * @returns {object} per-signal live counts, for the self-check report
     */
    describe() {
        const bySignal = {};
        for (const rec of this._records.values())
            bySignal[rec.signal] = (bySignal[rec.signal] || 0) + 1;
        return bySignal;
    }
}

/**
 * Tracks GLib timeouts. One-shot only, by design.
 */
export class TimerTracker {
    constructor(name = 'timers') {
        this._name = name;
        this._timers = new Map();
        this._nextKey = 1;
    }

    /**
     * Schedule a one-shot callback.
     *
     * The callback always returns GLib.SOURCE_REMOVE, so a tracked timer can
     * never become a repeating one by accident.
     *
     * @param {number} delayMs delay in milliseconds
     * @param {Function} callback to run once
     * @param {string} [label] for diagnostics
     * @returns {number} tracking key, for cancel()
     */
    oneShot(delayMs, callback, label = 'timer') {
        const key = this._nextKey++;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delayMs), () => {
            // Drop the record *before* running the callback: the callback may
            // itself call cancelAll(), and we must not then try to remove an
            // already-finished source.
            this._timers.delete(key);
            Log.guard(`timer ${label}`, callback);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.set(key, {id, label});
        return key;
    }

    /**
     * Cancel a pending timer.
     *
     * @param {number|null} key value returned by oneShot()
     */
    cancel(key) {
        if (key === null || key === undefined)
            return;
        const rec = this._timers.get(key);
        if (!rec)
            return;
        this._timers.delete(key);
        try {
            GLib.source_remove(rec.id);
        } catch {
            // Already fired or removed.
        }
    }

    /** Cancel every pending timer. */
    cancelAll() {
        const recs = [...this._timers.values()];
        this._timers.clear();
        for (const rec of recs) {
            try {
                GLib.source_remove(rec.id);
            } catch {
                // ignore
            }
        }
    }

    get count() {
        return this._timers.size;
    }

    describe() {
        const byLabel = {};
        for (const rec of this._timers.values())
            byLabel[rec.label] = (byLabel[rec.label] || 0) + 1;
        return byLabel;
    }
}

/**
 * Tracks Clutter "laters" - callbacks that run at a defined point in the next
 * frame cycle.
 *
 * This is the mechanism behind architecture rule 4 (transition ordering):
 * showing the glass and clearing the popup's own background must happen in
 * *different* frames, or the user sees a grey flash.
 */
export class LaterTracker {
    constructor() {
        this._laters = new Map();
        this._nextKey = 1;
        this._backend = null;
    }

    _getLaters() {
        if (this._backend !== null)
            return this._backend;
        // GNOME 44+ exposes laters through the compositor object. Older API was
        // Meta.later_add(). We support both and cache which one exists.
        try {
            const compositor = global.compositor;
            if (compositor && typeof compositor.get_laters === 'function') {
                this._backend = {kind: 'compositor', laters: compositor.get_laters()};
                return this._backend;
            }
        } catch (e) {
            Log.error(e, 'get_laters');
        }
        if (typeof Meta.later_add === 'function')
            this._backend = {kind: 'meta'};
        else
            this._backend = {kind: 'none'};
        return this._backend;
    }

    /**
     * Run `callback` once, before the next redraw.
     *
     * @param {Function} callback to run
     * @param {string} [label] for diagnostics
     * @returns {number} tracking key
     */
    add(callback, label = 'later') {
        const key = this._nextKey++;
        const run = () => {
            this._laters.delete(key);
            Log.guard(`later ${label}`, callback);
            return GLib.SOURCE_REMOVE;
        };

        const backend = this._getLaters();
        let id = null;
        try {
            if (backend.kind === 'compositor')
                id = backend.laters.add(Meta.LaterType.BEFORE_REDRAW, run);
            else if (backend.kind === 'meta')
                id = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, run);
        } catch (e) {
            Log.error(e, 'laters.add');
            id = null;
        }

        if (id === null) {
            // No laters available: fall back to a zero-delay one-shot timeout.
            // Still one frame-ish later, still one-shot.
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, run);
            this._laters.set(key, {id: timeoutId, kind: 'timeout', label});
            return key;
        }

        this._laters.set(key, {id, kind: backend.kind, label});
        return key;
    }

    /**
     * Cancel a pending later.
     *
     * @param {number|null} key value returned by add()
     */
    cancel(key) {
        if (key === null || key === undefined)
            return;
        const rec = this._laters.get(key);
        if (!rec)
            return;
        this._laters.delete(key);
        this._remove(rec);
    }

    /** Cancel every pending later. */
    cancelAll() {
        const recs = [...this._laters.values()];
        this._laters.clear();
        for (const rec of recs)
            this._remove(rec);
    }

    _remove(rec) {
        try {
            if (rec.kind === 'timeout') {
                GLib.source_remove(rec.id);
            } else if (rec.kind === 'compositor') {
                global.compositor.get_laters().remove(rec.id);
            } else if (rec.kind === 'meta') {
                Meta.later_remove(rec.id);
            }
        } catch {
            // Already ran.
        }
    }

    get count() {
        return this._laters.size;
    }
}

/**
 * Coalesces bursts of events into at most one action per interval.
 *
 * Architecture rule 2: always-visible surfaces are refreshed from events
 * (workspace switch, window created, restack, monitor change), never polled.
 * Those events arrive in bursts, so we need throttling - but the throttle must
 * itself be a one-shot, never a repeating tick.
 */
export class Throttle {
    /**
     * @param {TimerTracker} timers tracker that owns the deferred timeout
     * @param {number} minIntervalMs hard floor between two invocations
     * @param {Function} callback the work to throttle
     * @param {string} [label] for diagnostics
     */
    constructor(timers, minIntervalMs, callback, label = 'throttle') {
        this._timers = timers;
        this._minInterval = minIntervalMs;
        this._callback = callback;
        this._label = label;
        this._lastRun = 0;
        this._pending = null;
    }

    setMinInterval(ms) {
        this._minInterval = ms;
    }

    /** Request a run, honouring the minimum interval. */
    trigger() {
        if (this._pending !== null)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        const since = now - this._lastRun;

        if (since >= this._minInterval) {
            this._lastRun = now;
            Log.guard(`throttle ${this._label}`, this._callback);
            return;
        }

        const wait = Math.max(1, this._minInterval - since);
        this._pending = this._timers.oneShot(wait, () => {
            this._pending = null;
            this._lastRun = GLib.get_monotonic_time() / 1000;
            this._callback();
        }, this._label);
    }

    cancel() {
        if (this._pending !== null) {
            this._timers.cancel(this._pending);
            this._pending = null;
        }
    }
}
