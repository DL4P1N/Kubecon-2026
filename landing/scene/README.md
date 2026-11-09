# Pixel venue scene

A 3D pixel-art venue behind the whole page; page scroll drives the camera. Plain ES modules, three.js vendored, offline.

```html
<link rel="stylesheet" href="scene/venue.css">
<div data-venue data-venue-mode="background" aria-hidden="true"><img data-venue-still src="scene/still-overview.png" alt=""></div>
<section data-venue-shot="arrive" data-venue-side="left" data-venue-dim="0.3"> ... </section>
<button type="button" data-venue-control="pause">Pause motion</button>
<button type="button" data-venue-control="static">Static view</button>
<script type="module" src="scene/venue.js"></script>
```

**The one stacking rule**: `main, header, footer { position: relative; z-index: 1 }`, section grounds transparent (host: fixed, z-index 0).
**Shots** (`data-venue-shot`; the camera blends between consecutive shot elements around the viewport centre):
- `overview`: the whole floor, three-quarter view, people milling (also the top of the page and the default)
- `arrive`: entrance and registration desk: queue, host, badges appear, check bubbles
- `host`: close on the desk host and one attendee, speech bubbles alternating (chat sign-up)
- `schedule`: hallway and room doors; people peel off into rooms; recommended rooms get lime markers
- `scan`: a breakout door: stop at the scanner, lime flash, step in; some scans are denied (cross, turns back)
- `stage`: the keynote hall: speaker, lit screen, seated audience
- `lounge`: tables, coffee bar, pairs chatting
- `clusters`: from above, walls drop to outlines, everyone takes an interest colour and groups; a group under 5 turns grey and joins "other"

Unknown names fall back to `overview` (console.warn). Close shots are drawn as a diorama cut: the content side stays empty ground.
- `data-venue-side="left|right|center|top"`: where your content sits; the subject goes opposite. Below 760px every side is `top`.
- `data-venue-dim="0..1"`: dim strength while that shot is current (eased). Default `--venue-dim` (0.25).
- `data-venue-data="data/demo-aggregates.json"` on the host (optional): cluster sizes and "other", room fill
  (rooms are `keynote`, `room-a`..`room-d`, `lounge`) and the denied-scan share drive the crowd; on any failure, defaults.
- Events: on shot change `data-venue-shot-current="<name>"` goes on the host and `<html>`, and the host dispatches a bubbling
  `venue:shot` CustomEvent (`detail: { name, index, element }`). `<html data-venue-state="playing|paused|static">`.
- Controls: every `[data-venue-control="pause|static"]` is wired (`aria-pressed` kept; text swapped only if
  `data-label-on` / `data-label-off` exist); the choice is remembered in localStorage.
- API: `host.venue = { pause(), play(), setStatic(bool), goTo(name), spawn({ label }), ready /* Promise<{live}> */, destroy() }`.
  `spawn` (or `document.dispatchEvent(new CustomEvent('venue:spawn', { detail: { label } }))`): a new person walks in at the
  entrance to the desk, gets a badge and a check bubble, with a pixel name label (A–Z a–z 0–9 space, 12 chars) for a few seconds.
- CSS variables (read at mount): `--venue-bg`, `--venue-floor`, `--venue-wall`, `--venue-ink` (light ink: bubbles, outlines),
  `--venue-accent` (doors, scanners, screens, markers, name labels).

Fallbacks: reduced motion shows one composed still per shot (cuts, no walking); no WebGL or any error leaves the `<img>`. Stills: `still-overview.png` (`still-ambient.png` is a copy), `still-arrive.png`, `still-host.png`, `still-clusters.png`. Demo: `scene/demo.html`.
