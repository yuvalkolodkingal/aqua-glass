import {Actor} from '../core.mjs';

class Clone extends Actor {
    constructor(params = {}) {
        super(params);
        this.source = params.source ?? null;
        if (this.source) {
            this.width = this.source.width;
            this.height = this.source.height;
        }
    }
}

class Text extends Actor {}

export default {
    Actor,
    Clone,
    Text,
    ActorAlign: {FILL: 0, START: 1, CENTER: 2, END: 3},
    AnimationMode: {LINEAR: 0, EASE_OUT_QUAD: 1},
    BinLayout: class BinLayout {},
    Orientation: {HORIZONTAL: 0, VERTICAL: 1},
};
