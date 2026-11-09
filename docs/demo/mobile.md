# Mobile layout evidence

Viewport checks cover register, onboarding, schedule with QR, populated search,
interest map, service status and kiosk at 375×812 and 768×1024.
Fourteen browser cases passed in installed Edge after the changes, including
axe WCAG A/AA serious/critical checks. These are mocked-API layout tests, not
proof of live search relevance, access decisions or service health.

`mobile-before-<page>-<width>.png` captures the original layout;
`mobile-after-<page>-<width>.png` captures the fixed layout. All 28 images use
synthetic fixtures. The before mode captures screenshots only and deliberately
does not claim the old layout passed the new touch-target assertions.

The changes give visible navigation links, buttons, text controls and summaries
a 44px minimum target. Checkbox labels provide the larger clickable target
while the native checkbox remains compact. Navigation/status text wraps on
phones; tables fit the content width; search columns stack below 600px;
the QR stays at least 240px wide and retains its text alternative. The kiosk
decision card uses less padding at phone width.

Run `npm run test:a11y -w web -- --grep mobile`. Set
`PLAYWRIGHT_CHANNEL=msedge` to use installed Edge. To regenerate after images,
also set `MOBILE_CAPTURE=1`. Baseline capture is an explicit diagnostic mode
(`MOBILE_CAPTURE_BEFORE=1`) and is not used by CI.

CI runs the same default assertions in Chromium as part of the existing
accessibility workflow. A physical-phone camera/QR scan and a manual mobile
screen-reader audit have not been performed.
