import {Actor} from '../core.mjs';

export default {
    LaterType: {RESIZE: 0, CALC_SHOWING: 1, CHECK_FULLSCREEN: 2, SYNC_STACK: 3, BEFORE_REDRAW: 4, IDLE: 5},
    BackgroundGroup: class BackgroundGroup extends Actor {},
    // Deliberately absent: later_add / later_remove. GNOME 44+ routes laters
    // through global.compositor.get_laters(), and the extension must use that
    // path rather than the removed global functions.
};
