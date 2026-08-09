# Memory test

The failure this extension is built to avoid is unbounded growth in the
gnome-shell process. Two specific regressions motivated the architecture:

- a full-screen offscreen framebuffer allocated **per popup**, which reached
  **2.3 GB** and killed the session; and
- a **250 ms screenshot loop** on the dock — an always-visible surface — which
  reached **2 GB in 32 seconds**.

Both are the kind of bug that looks fine for the first minute of use. So the
test below is not a formality: run it after any change to the glass lifecycle.

## The quick version

```sh
make memtest
```

This opens and closes 50 menus from inside the shell and reports the RSS delta.
It runs in the gnome-shell process, so it measures the right thing without any
external tooling, and it drives real menu open/close cycles rather than calling
internal functions.

Expected output:

```
Aqua Glass memory test: 50 open/close cycles
  RSS before : 312.4 MiB
  RSS after  : 314.1 MiB
  delta      : +1.7 MiB
  effects created during test : 0 (expected 0)
  effects live                : 3

RESULT: PASS - RSS returned to baseline and no new effects were built.
```

**The line that matters most is `effects created during test: 0`.** RSS moves
around for reasons that have nothing to do with us — JIT warm-up, GC timing,
icon and font caches — but a *newly built effect* during 50 menu opens is
unambiguous: it means the glass is being rebuilt per popup instead of
retargeted, which is precisely the bug that consumed 2.3 GB. That number must
be zero.

`effects live` should equal 1 (the shared popup glass) plus one per active
always-visible surface — so 2 with the panel enabled and no dock, 3 with both.

## The manual version

If you want to watch it happen, or `make memtest` is unavailable:

```sh
# 1. Baseline. Let the session settle for a minute after login first.
ps -o rss= -C gnome-shell | awk '{printf "baseline: %.1f MiB\n", $1/1024}'

# 2. Snapshot the extension's own accounting.
make selfcheck
```

Then open and close 50 menus by hand — click the Quick Settings button, press
Escape, repeat — or drive it from a terminal:

```sh
for i in $(seq 50); do
  gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell/Extensions/AquaGlass \
    --method org.gnome.Shell.Extensions.AquaGlass.MemoryTest 1 >/dev/null
done
```

```sh
# 3. Let the GC settle, then re-measure.
sleep 5
ps -o rss= -C gnome-shell | awk '{printf "after: %.1f MiB\n", $1/1024}'
make selfcheck
```

### Reading the result

| Observation | Verdict |
|---|---|
| RSS returns to roughly baseline (±25 MiB) | Pass |
| `effects created` unchanged across the run | Pass — the shared glass is being retargeted, not rebuilt |
| RSS climbs by a few MiB per menu and stays up | **Fail** — a framebuffer is being allocated per popup |
| RSS climbs while the shell is *idle* | **Fail** — something is sampling on a timer |
| `Timers: n pending` with n large and growing on an idle shell | **Fail** — a timer is rescheduling itself |
| `Signals` growing steadily across opens | **Fail** — a connect without a matching disconnect |

A baseline around 300 MiB is normal for gnome-shell with a few extensions
loaded. What matters is the *shape* of the curve, not the absolute number:
it should be flat.

## Framebuffer budget

The self-check reports the approximate framebuffer footprint directly:

```
framebuffers     : ~21.3 MiB
```

This should be stable regardless of how many menus you open, because there is
exactly one shared popup glass. It scales with the size of the glass region,
not with the number of popups — the glass actor is monitor-sized but clipped to
the glass rectangle plus its shadow, so a small menu costs a small framebuffer.

## Disable/enable cycling

A leak on the enable path is just as fatal, and easier to miss:

```sh
for i in $(seq 20); do
  gnome-extensions disable aqua-glass@yuvalkolodkingal.github.io
  sleep 1
  gnome-extensions enable aqua-glass@yuvalkolodkingal.github.io
  sleep 1
done
make selfcheck
```

After this, `created` should equal `destroyed + live`, `Signals` should be back
to its steady-state count, and `Timers: 0 pending`. A mismatch in the
created/destroyed accounting is reported as a problem by the self-check itself.
