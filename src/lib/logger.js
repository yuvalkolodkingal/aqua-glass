// Aqua Glass - logging.
//
// Everything this extension does runs inside gnome-shell. On Wayland a crash
// logs the user out, so we never let a logging call be the thing that throws.

const PREFIX = '[aqua-glass]';

let _debugEnabled = false;

export function setDebugEnabled(enabled) {
    _debugEnabled = !!enabled;
}

export function debugEnabled() {
    return _debugEnabled;
}

export function debug(...args) {
    if (!_debugEnabled)
        return;
    try {
        console.debug(`${PREFIX} ${args.join(' ')}`);
    } catch {
        // Never let logging be fatal.
    }
}

export function info(...args) {
    try {
        console.log(`${PREFIX} ${args.join(' ')}`);
    } catch {
        // ignore
    }
}

export function warn(...args) {
    try {
        console.warn(`${PREFIX} ${args.join(' ')}`);
    } catch {
        // ignore
    }
}

/**
 * Report an exception without ever rethrowing.
 *
 * @param {Error} e exception
 * @param {string} context where it happened
 */
export function error(e, context = '') {
    try {
        logError(e, `${PREFIX} ${context}`);
    } catch {
        try {
            console.error(`${PREFIX} ${context}: ${e}`);
        } catch {
            // ignore
        }
    }
}

/**
 * Run `fn`, swallowing and reporting any exception.
 *
 * Used at every boundary where a callback re-enters our code from the shell
 * (signal handlers, timeouts, laters). An exception escaping one of those
 * boundaries is what turns a bug into a session logout.
 *
 * @param {string} context label for the journal
 * @param {Function} fn thunk to run
 * @param {*} fallback value to return if `fn` threw
 * @returns {*} the result of `fn`, or `fallback`
 */
export function guard(context, fn, fallback = undefined) {
    try {
        return fn();
    } catch (e) {
        error(e, context);
        return fallback;
    }
}
