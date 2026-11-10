# Apple Wallet pass (app half only; nothing here is signed)
1. Developer portal: Identifiers > Pass Type IDs > create one, then create its certificate; export as `pass.p12` from Keychain.
2. Fill `pass.json` (passTypeIdentifier, serialNumber, barcode message = the ticket QR text, venue, coordinates are placeholders). Add `icon.png` and `icon@2x.png` beside it.
3. `openssl pkcs12 -in pass.p12 -clcerts -nokeys -out passcert.pem` and `-nocerts -out passkey.pem`; download Apple WWDR G4 as `wwdr.pem`.
4. Either `signpass -p <pass folder>` (Apple's Wallet sample tool), or by hand:
5. `cd <pass folder> && shasum pass.json icon.png icon@2x.png` into `manifest.json` as {"file":"sha1",...}
6. `openssl smime -binary -sign -certfile wwdr.pem -signer passcert.pem -inkey passkey.pem -in manifest.json -out signature -outform DER`
7. `zip -r <slug>.pkpass pass.json icon.png icon@2x.png manifest.json signature`
8. Serve as `<base>/site/passes/<slug>.pkpass` with `Content-Type: application/vnd.apple.pkpass`.
9. The app shows "Add to Apple Wallet" only if that URL answers a HEAD request with that type.

Notes
- The app needs no Wallet entitlement: it downloads the file and hands it to `PKAddPassesViewController`.
- One pass per conference (`<slug>.pkpass`, slug = the conference `slug` in `conferences.json`), not per attendee. The ticket QR token is short-lived (the app refreshes it), so a static pass cannot carry a live door token; use the pass for the event, venue and relevance on the lock screen.
- `teamIdentifier` in `pass.json` must match the signing team (project team: U2B6QHT22K); `passTypeIdentifier` must match the Pass Type ID certificate you sign with.
- `locations` and `relevantDate` are placeholders: set them to the venue and the first session start.
- The button is hidden on devices where `PKAddPassesViewController.canAddPasses()` is false (including some simulators) and when the HEAD request is not a 200 with `application/vnd.apple.pkpass`.
- Nothing in this folder is signed; an unsigned `.pkpass` is rejected by Wallet.
