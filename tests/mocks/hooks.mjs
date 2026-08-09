// Node ESM resolver hooks that make the extension's GNOME imports loadable
// outside gnome-shell.
//
// `gi://Clutter`            -> tests/mocks/gi/Clutter.mjs
// `resource:///org/gnome/…` -> tests/mocks/res/org_gnome_….mjs

const base = new URL('./', import.meta.url);

export async function resolve(specifier, context, next) {
    if (specifier.startsWith('gi://')) {
        const name = specifier.slice('gi://'.length).split('?')[0];
        return {url: new URL(`gi/${name}.mjs`, base).href, shortCircuit: true};
    }

    if (specifier.startsWith('resource:///')) {
        const flat = specifier
            .slice('resource:///'.length)
            .replace(/\.js$/, '')
            .replace(/[/.]/g, '_');
        return {url: new URL(`res/${flat}.mjs`, base).href, shortCircuit: true};
    }

    return next(specifier, context);
}
