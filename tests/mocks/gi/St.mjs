import {Actor, Emitter} from '../core.mjs';

class Widget extends Actor {}
class Label extends Widget {}
class Icon extends Widget {}
class DrawingArea extends Widget {}
class BoxLayout extends Widget {}
class Bin extends Widget {}

const settingsSingleton = new (class StSettings extends Emitter {
    constructor() {
        super();
        this.accent_color = 0;
        this.color_scheme = 0;
    }
})();

class Theme extends Emitter {
    constructor() {
        super();
        this.loaded = [];
    }

    load_stylesheet(file) {
        this.loaded.push(file);
    }

    unload_stylesheet(file) {
        const i = this.loaded.indexOf(file);
        if (i >= 0)
            this.loaded.splice(i, 1);
    }
}

const themeSingleton = new Theme();

export default {
    Widget,
    Label,
    Icon,
    DrawingArea,
    BoxLayout,
    Bin,
    Side: {TOP: 0, RIGHT: 1, BOTTOM: 2, LEFT: 3},
    Settings: {get: () => settingsSingleton},
    ThemeContext: {
        get_for_stage: () => ({get_theme: () => themeSingleton}),
    },
    __theme: themeSingleton,
};
