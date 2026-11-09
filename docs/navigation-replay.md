# Offline navigation replay

The route `/nav-demo` is disabled by default and is outside the attendee
navigation. Enable it at frontend build/dev-server startup with
`NAV_ESTIMATOR=on`. In PowerShell: `$env:NAV_ESTIMATOR='on'`, then
`npm.cmd run dev:web` (or `npm.cmd run build`). Unset the variable or rebuild
with any other value to disable it. This is a build-time flag, not a setting
on the running nginx container.
For a container build, pass `--build-arg NAV_ESTIMATOR=on` to
`docker build -f web/Dockerfile`; the default image keeps the route disabled.

`data/nav-replay.json` contains entirely synthetic vectors for three labelled
demo rooms and five replay frames. The estimator uses one nearest neighbor
with Euclidean distance. Invalid or mismatched vectors return unknown.
Play, pause, step and reset controls only move through these local frames;
there are no device APIs, location requests, network requests or telemetry
calls in the estimator or replay page. No accuracy figures are claimed.

The page prominently states “Simulated signal replay, not measured at the
venue.” It must not be presented as live venue positioning.
