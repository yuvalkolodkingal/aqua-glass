export default {
    // Values mirror CoglSnippetHook's declaration order in cogl-snippet.h.
    SnippetHook: {
        VERTEX_GLOBALS: 0,
        FRAGMENT_GLOBALS: 1,
        VERTEX: 2,
        VERTEX_TRANSFORM: 3,
        POINT_SIZE: 4,
        FRAGMENT: 5,
        TEXTURE_COORD_TRANSFORM: 6,
        LAYER_FRAGMENT: 7,
        TEXTURE_LOOKUP: 8,
    },
    Color: class Color {
        constructor(r = 0, g = 0, b = 0, a = 255) {
            this.red = r;
            this.green = g;
            this.blue = b;
            this.alpha = a;
        }
    },
};
