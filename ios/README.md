# Conference Companion (iOS 26+, SwiftUI, iPhone, dark only)
Build and install on a plugged-in iPhone (team U2B6QHT22K, bundle id com.erickwhatcott.conferencecompanion):
`xcodebuild -project ios/ConferenceCompanion.xcodeproj -scheme ConferenceCompanion -destination 'id=<UDID>' -allowProvisioningUpdates -derivedDataPath ios/build build`
then `xcrun devicectl device install app --device <UDID> ios/build/Build/Products/Debug-iphoneos/ConferenceCompanion.app` and `... process launch --device <UDID> com.erickwhatcott.conferencecompanion`.
Tickets: register (name, role, interests), QR door ticket (brightness raised), Wi-Fi join (Hotspot entitlement), directions, reminders, Wallet button.
Find my room: plan, route, steps, nearby pixel people. Profile: pixel avatar, interests, history, invite, linked accounts, Settings (Server URL).
Simulated: demo tickets (no server), Wi-Fi values, "Simulated signals" position and the 16 other attendees, sample history. Live: Bluetooth scan with 3 calibrated devices.
Needs a server (Settings > Server URL): live tickets (/api/register, /api/access/token), catalogue refresh, invite and web links, account linking (/api/auth/*).
Wallet needs a signed pass at <base>/site/passes/<slug>.pkpass (see ios/Wallet/README.md). Deep link: confcompanion://ticket?c=<slug>&name=&role=&interests=&avatar=
Launch arguments for screenshots: -startTab find|profile|ticket, -seedTicket 1. Liquid Glass: floating controls on the plan and ticket; bars/tabs/sheets use system glass.
Last good device build is kept in ios/build/last-good/ (git-ignored).
