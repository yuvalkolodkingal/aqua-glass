# Aqua Glass

An Apple-style **Liquid Glass** material for the GNOME Shell UI — refractive,
specular, and adaptive — drawn behind the panel, menus, Quick Settings,
notifications, OSD popups, switchers and the dock.

It is intended to replace **both** [liquid-glass][lg] and [Blur My Shell][bms]:
it covers the same surfaces natively, and it detects and defuses conflicts with
both Blur My Shell and Dash to Dock rather than stacking effects on top of them.

**Target:** GNOME Shell 48 / 49 / 50, Wayland or X11. Developed against Debian
13 (GNOME Shell 48.7, Mutter 48). ESM extension, GNOME 45+ style.

[lg]: https://github.com/ryohsuke1231/liquid-glass
[bms]: https://github.com/aunetx/blur-my-shell

---

## Install

One command:

```sh
curl -fsSL https://raw.githubusercontent.com/yuvalkolodkingal/aqua-glass/refs/heads/main/web-install.sh | bash
```

Then log out and back in — Wayland cannot restart the shell in place — and:

```sh
gnome-extensions enable aqua-glass@yuvalkolodkingal.github.io
```

**Uninstall**, including reverting every change made to other extensions:

```sh
curl -fsSL https://raw.githubusercontent.com/yuvalkolodkingal/aqua-glass/refs/heads/main/uninstall.sh | bash
```

Preferences: `gnome-extensions prefs aqua-glass@yuvalkolodkingal.github.io`

<details>
<summary>From a clone, or installing a specific branch</summary>

```sh
git clone https://github.com/yuvalkolodkingal/aqua-glass
cd aqua-glass && ./install.sh      # then enable as above
./uninstall.sh                     # to remove
```

The network installer takes environment overrides:

```sh
# install a branch, tag or commit other than main
curl -fsSL .../web-install.sh | AQUA_GLASS_REF=some-branch bash

# install without enabling
curl -fsSL .../web-install.sh | AQUA_GLASS_NO_ENABLE=1 bash
```

Requires `curl`, `tar` and `glib-compile-schemas` (Debian/Ubuntu:
`libglib2.0-bin`; Fedora: `glib2`).
</details>

---

## Surfaces

Each is independently toggleable in preferences.

| Surface | Notes |
|---|---|
| Top panel | Replaces Blur My Shell's panel component |
| Panel status-area menus | Any menu opened from the top bar |
| Date / calendar menu | Including the notification list |
| Quick Settings | Toggles and sliders keep their own colours (see below) |
| Notifications | Banners |
| OSD popups | Volume, brightness |
| Dash to Dock | Detected at runtime; its own background is neutralised |
| Context menus | Right-click menus on apps and the desktop |
| Window menus | Title-bar menus |
| Input-source switcher | The language / keyboard-layout popup |
| Alt-Tab | Window and application switcher |
| IBus candidate popup | Input-method candidates |
| Workspace switcher | Workspace indicator popup |

---

## The material

### How it is layered

The material is built from two layers, and the split is deliberate:

**1. The surface** — a `St.Widget` carrying `Shell.BlurEffect` in **BACKGROUND**
mode plus a translucent tint, rounded corners, a hairline rim and a soft drop
shadow. BACKGROUND blur reads the real framebuffer behind the actor, so it needs
no copy of the screen, no coordinate arithmetic and no framebuffer of our own.
This layer alone is already a credible frosted-glass surface.

**2. The light** — the GLSL layer on top, adding the specular highlight, the
Fresnel rim and the directional sheen. It composites *additively* and samples no
texture, so if it fails it costs a highlight, not the whole surface.

Edge refraction is the one thing that genuinely needs a live copy of the screen
inside our own framebuffer, so it is opt-in (**Material → Edge refraction**).
Earlier versions put the entire appearance behind that copy; when it produced
nothing, menus rendered with no background at all — text floating on the
wallpaper. Now the worst case is a surface without lensing.

The shader models the panel as a glass slab whose thickness rises from zero at
the edge to full over a configurable bevel, following a **spherical-cap
profile**. That profile is not an aesthetic choice — its derivative reaches
zero at the top, so the centre of the panel is exactly flat and therefore
completely undistorted, while the edge carries all of the lensing. A linear
ramp would distort the whole surface evenly and read as plastic wrap.

On top of that:

- **Refraction** via Snell's law at IOR **1.5** (glass; 2.4 would be diamond),
  computed from the analytic gradient of a rounded-rectangle signed distance
  field so the normal stays exact around the corner arcs.
- **Chromatic aberration** from per-channel IOR, and *only* at the edge —
  dispersion is proportional to how steeply the ray is bent, so it is confined
  to the bevel by construction.
- **Specular highlights**, on by default. Blinn-Phong against the bevel normal,
  masked to the bevel: in the flat centre the normal is constant, so an
  unmasked highlight becomes a uniform white film over the whole panel. A glass
  surface with no specular reads as flat plastic.
- **Fresnel rim light** (Schlick, F0 = 0.04). Naturally rim-only: the normal's
  z is 1 in the centre and falls to 0 at the edge.
- **A directional sheen gradient**, not a constant. A constant sheen is the
  "milky plastic" look; the sweep from the light-facing edge to the far edge is
  what reads as a curved, lit surface.
- **A soft, wide drop shadow** rather than a hard contact ring.

One light-direction setting drives the specular highlight, the rim *and* the
shadow, so the material cannot disagree with itself about where the light is.

---

## Adaptive text

Transparent surfaces put theme-coloured text over an arbitrary wallpaper. Three
things make naive implementations oscillate or fail contrast; all three are
handled explicitly.

**It measures somewhere with no text in it.** Sampling the surface itself
measures the text you just recoloured, so the decision depends on its own
previous output. Aqua Glass samples the raw backdrop in a ring *outside* the
surface, then predicts analytically what the glass will do to it — applying the
same saturation, brightness and tint the shader applies — and decides from that.

**It uses WCAG-correct luminance, in one colour space.** sRGB is linearised
(`c <= 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`) before computing
`0.2126R + 0.7152G + 0.0722B`. Comparing a linear luminance against a threshold
picked by eye from sRGB values puts the decision point roughly 3× too high.

**It uses pure `#ffffff` / `#000000`, and hysteresis.** The two are related:

| Foreground pair | Worst case over all backdrops |
|---|---|
| `#f2f2f2` / `#1a1a1a` | **3.94:1** — fails AA in a band around L ≈ 0.16–0.22 |
| `#ffffff` / `#000000` | **4.58:1** — clears AA 4.5:1 at *every* backdrop luminance |

White and black are equally legible at L = √(1.05×0.05) − 0.05 = **0.179**, and
that crossover is the worst case, which is exactly why the pure endpoints are
safe everywhere. A dead band of ±0.04 around that point stops backdrops sitting
near it from flipping between opens. Both claims are asserted in the test suite
(`make test`), including a check that the sequence which settles *with* the dead
band genuinely oscillates without it.

### What it deliberately does not recolour

Widgets that paint their own filled background — `.quick-toggle`,
`.quick-slider`, `.icon-button`, `.quick-settings-system-item`, `.message`,
`.events-button`, `.calendar-today`, `.item-box`, `.selected` — are already
paired by GNOME with `-st-accent-fg-color`. Overriding their labels would put
black text on an accent-blue pill. The tree walk **prunes those subtrees
entirely**, since their children sit on the filled background too.

That leaves a real contrast failure sitting on the glass, because GNOME pairs
accent chips with white text and several stock accents fall short:

| Accent | On white |
|---|---|
| blue `#3584e4` | 3.77:1 ✗ |
| green `#3a944a` | 3.79:1 ✗ |
| teal `#2190a4` | 3.90:1 ✗ |

So Aqua Glass leaves the chip's text alone and **darkens the chip** until its
own white label passes AA, via a small generated stylesheet. Every one of the
nine stock accents is verified to reach 4.5:1 after adjustment in the tests.

---

## Replacing Blur My Shell / Dash to Dock

**Blur My Shell.** On enable, if BMS is running with any overlapping component
(`panel`, `popup`, `dash-to-dock`, `dash-to-panel`), Aqua Glass posts a
notification offering to switch those off — running both stacks two blurs over
the same pixels. It asks rather than acting: another extension's configuration
belongs to the user.

**Dash to Dock.** Its default `transparency-mode` is `DYNAMIC`, which fades a
nearly-opaque background in whenever a window comes near the dock — straight
over the glass. Aqua Glass pins it to `FIXED` with `customize-alphas=true` and
all alphas at 0.

**Both are reverted.** The previous values are saved before anything is
changed, and restored when Aqua Glass is disabled, so switching it off never
leaves the dock invisible or Blur My Shell mysteriously off. `uninstall.sh`
replays the same backups directly as a fallback, in case the extension was not
running to do it itself.

---

## Diagnostics

Leaks should be provable, not assumed. Every resource is owned by a tracker
that can be counted:

```sh
make selfcheck        # or the Diagnostics page in preferences
```

```
Effects
  shared popup effects : 1   (must be 1)
  persistent effects   : 2
  created / destroyed  : 3 / 0
  live                 : 3

Popups
  tracked   : 14
  attached  : 0
Signals : 63 live
Timers  : 0 pending, 0 repeating
RESULT: OK - no leaks or rule violations detected.
```

The report flags rule violations directly — more than one shared popup effect,
live effects exceeding active surfaces, a created/destroyed accounting
mismatch, or an implausible number of signals or timers.

Also available from Looking Glass as `aquaGlass.selfCheck()`, and over D-Bus at
`org.gnome.Shell.Extensions.AquaGlass`.

**Memory test:** see [docs/MEMORY-TEST.md](docs/MEMORY-TEST.md), or just
`make memtest` — it opens and closes 50 menus from inside the shell and reports
the RSS delta.

---

## Architecture

Six constraints shape the whole design. Each corresponds to a specific, known
failure mode.

**1. One shared glass for all transient popups.** Only one popup is on screen
at a time, so the glass is built once, *retargeted*, and destroyed once.
Attaching to a popup allocates nothing but signal ids. (A full-screen offscreen
framebuffer per menu is what drove gnome-shell to 2.3 GB.)

**2. No repeating timers on permanently-visible surfaces.** The backdrop is a
live `Clutter.Clone` of `global.window_group` — which contains the wallpaper's
`Meta.BackgroundGroup` lowered to the bottom, so one clone gives wallpaper plus
every window in correct stacking order, updating for free. There is nothing to
poll. Geometry and text are recomputed from *events* (monitors-changed,
workspace-switched, restacked, window-created, allocation changes), throttled
with a hard minimum interval. `TimerTracker` exposes no repeating-timer API at
all, so the rule is enforced by construction.

**3. The framebuffer is full-monitor, not popup-sized.** Window clones sit at
absolute screen coordinates, so a popup-sized actor puts every clone outside
the framebuffer and renders grey. The glass actor covers the monitor at the
monitor origin; the glass rectangle is passed separately in monitor-local
coordinates; the clone is shifted by `(-monitor.x, -monitor.y)`.

The actor also carries a **clip** covering just the glass and its shadow.
`clutter_actor_real_get_paint_volume()` returns the clip verbatim when one is
set, so the framebuffer shrinks to the region that actually has glass in it —
which keeps an always-visible surface from clearing and rasterising a
full-monitor quad every frame. The coordinate system is unchanged; only the
cost is. The shader derives its uv↔pixel mapping from the real paint volume
rather than assuming it, including Clutter's ~3px stability padding.

**4. Transition ordering, both directions.** Opening: show the glass while the
popup still has its opaque background, and make it transparent one frame later.
Closing: restore the background first, hide the glass one frame later. Doing
either in a single frame flashes grey.

**5. Tear down when the popup is GONE, not when `close()` is called.**
`PopupMenu.close()` emits `open-state-changed(false)` immediately and only
calls `hide()` from the fade-out's `onComplete`, so restoring the opaque
background on that signal makes the user watch a grey menu fade out. The
predicate used instead — `visible && mapped`, re-evaluated on `notify::visible`,
`notify::mapped` and `destroy` — is true exactly when the popup is really on
screen, for every popup class, with no knowledge of close animations. That is
what lets it survive the GNOME 49 animation rework (added scale, flipped the
close translation sign) with no version branch. A bounded one-shot verify pass
backs it up so nothing can strand the glass on screen.

**6. Transparency means clearing the inner content box.** GNOME paints menu
backgrounds on `.popup-menu-content` (and `.candidate-popup-content`,
`.switcher-list`, `.workspace-switcher`, `.osd-window`), not on the BoxPointer
— for a stock `popup-menu-boxpointer` the cairo bubble path is built and then
discarded, because the theme sets neither `-arrow-background-color` nor
`-arrow-border-width`. Background colour, the 1px border *and* the box-shadow
all have to go or a ghost outline survives.

> Aqua Glass sets only `-arrow-background-color` and `-arrow-border-color`,
> which are paint-only. `-arrow-border-width` and `-arrow-rise` are read in
> BoxPointer's `vfunc_get_preferred_width/height`, `vfunc_allocate` and
> `_reposition` — changing them **moves and resizes menus**.

### Crash safety

This code runs inside gnome-shell; on Wayland a crash logs the user out
instantly. So: every signal, timer and later goes through a tracker;
`disable()` drains all of them unconditionally and in a defined order; every
actor access is guarded against the finalized-wrapper case; every callback
crossing back from the shell into our code is wrapped so an exception cannot
propagate into a C signal emission. The glass actor and all its children are
non-reactive, so the panel stays fully interactive — the glass can never
swallow a click.

---

## Development

```sh
make check     # syntax-check every file, validate the schema, run unit tests
make test      # the colour-science tests alone
make install
make logs      # journalctl, filtered
```

The colour science (`src/lib/color.js`) and the light-direction convention
(`src/lib/shader.js`) import nothing from GI, so they are unit-tested under
plain node — which is how the contrast claims above are checked rather than
asserted.

### Layout

```
src/extension.js            lifecycle, event routing, teardown
src/prefs.js                preferences (separate process; talks over D-Bus)
src/lib/shader.js           the GLSL material
src/lib/glassEffect.js      Shell.GLSLEffect subclass, uniforms, uv mapping
src/lib/glassSurface.js     one glass instance: actors, geometry, retargeting
src/lib/popupSurfaces.js    every transient popup, served by one shared glass
src/lib/persistentSurfaces.js  panel and dock, event-driven refresh
src/lib/adaptiveText.js     tree walk, subtree pruning, class application
src/lib/sampler.js          pixel sampling and glass-luminance prediction
src/lib/color.js            WCAG luminance, contrast, hysteresis
src/lib/transparency.js     reversible background clearing
src/lib/integrations.js     Blur My Shell / Dash to Dock, with backups
src/lib/trackers.js         signal/timer/later trackers; one-shots only
src/lib/selfcheck.js        the diagnostic report and D-Bus interface
```

---

## Known limitations

- Only one popup can hold the glass at a time. If a second opens over the
  first (an OSD over a menu), the first gets its normal background back and is
  handed the glass again when the second closes.
- The backdrop clones `global.window_group`, so content in
  `global.top_window_group` (some always-on-top and override-redirect windows)
  is not refracted.
- During a close, the glass fades in lockstep with the popup's opacity but does
  not mirror the scale animation GNOME 49 added; over 150 ms this is not
  visible in practice.
- Adaptive text is measured once per open. A popup left open while the window
  behind it changes colour keeps its original decision until reopened.

## Licence

GPL-3.0-or-later, matching GNOME Shell.
