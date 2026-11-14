
## Design engineer requests

- Project setting (both Debug and Release of target ConferenceCompanion): add
  `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;` (lime #c6f19d, set in
  `ConferenceCompanion/Assets.xcassets/AccentColor.colorset`). `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`
  is already present, so the regenerated icon needs nothing else.
- App icon: `Assets.xcassets/AppIcon.appiconset/icon-1024.png` (opaque, no alpha). It was generated once; the generator script is no longer in the repo.
  Needs a clean/rebuild of the asset catalog to show on the device.
- New Theme API (additive): `Theme.surface2/lineStrong/ink/accentInk/error`; text styles
  `.ccDisplay() .ccTitle() .ccHeadline() .ccBody() .ccLabel() .ccData() .ccCaption()`; `.ccCard()`,
  `.ccChip(selected:)`, `CCSectionLabel`, `.buttonStyle(.ccPrimary/.ccSecondary)`; glass (control layer only):
  `glassControlGroup { }`, `.ccGlassSurface()`, `.ccGlassButton(prominent:)`.

## Tickets engineer requests
- `Models/AppStore.swift` `register(...)`: `tickets.removeAll { same slug }` drops the old ticket without `NotificationService.cancelAll(ticketID:)`; call it for each removed ticket before `removeAll` (otherwise a re-registration leaves the old ticket's reminders pending). Also call `store.remove` only via the existing path (already cancels). Low priority for the demo.
- Nothing needed for notifications: `NotificationService.install()` (delegate, foreground banner+sound) is already called from `ConferenceCompanionApp.init`. Entitlements already contain HotspotConfiguration; ATS is already in Info.plist.
- [find-room engineer] RootView/AppNavigation: please add `var findRoomID: String?` to `AppNavigation` (a FloorPlan room id: stage, room-a, room-b, lobby, lounge) and pass it as `FindRoomView(initialDestinationID: nav.findRoomID)` in RootView. The view already accepts the parameter (defaults to nil, so nothing changes until this lands). Optional: set it from a ticket's session/room when "Find my room" is tapped.

## Integrator log
- [integrator 16:17] applied: GLOBAL_ACCENT_COLOR_NAME, AppStore cancelAll on re-register, AppNavigation.findRoomID + FindRoomView(initialDestinationID:). Device build installed and launched; last-good saved.

## Profile engineer notes
- [profile] FYI, no action needed: `Avatar` now uses the website's exact palette (old hex values were different) and `Avatar(wire:)` is strict (nil unless every colour is a palette value). `Avatar.skins/hairs/shirts/pantsOptions` and `drawPixelPerson(_:bottomCenter:cell:)` keep their names/footprint (8x12 cells, now drawn as the website's 16x24 pixel figure). `DeepLink.parseLinked` is the strict parser behind `AuthService.parseLinked`; RootView needs no change. Settings "Reset demo data" and "Clear sample history" are done in the views through `store.tickets`/`store.profile`/`store.save()`; no AppStore change requested.

## Organiser / RoomPlan engineer requests
- [roomplan] Info.plist: add `NSCameraUsageDescription` = "The camera and LiDAR scan a room's walls so organisers can add it to the venue floor plan."
- [roomplan] Entry point (one line): add a row/button "Organiser tools" that navigates to `OrganizerToolsView()` (self-contained; owns its own NavigationStack-free List, so push it inside the Profile tab's existing NavigationStack, or present it in a `.sheet`). No AppStore changes needed; scans are stored as JSON in Application Support/RoomScans.
- [roomplan] No other project changes: RoomPlan is a system framework (auto-linked via `import RoomPlan`); no entitlement needed. App is not required to declare `arkit` in UIRequiredDeviceCapabilities (scan view shows a plain "needs LiDAR" state when unsupported).
- [roomplan -> find-room engineer] If you expose a function to add a scanned room/receivers to the live floor plan, note its exact signature here; ScannedRoom has `outline: [Point2D]` (metres), `width`, `depth`, `areaM2`, `receiverSpots`, `doors`. I will wire an "Add to floor plan" button if the note exists by 4:40.
- [integrator 16:30] applied NSCameraUsageDescription. Will add a fourth tab "Organiser" in RootView once OrganizerToolsView exists in the tree.
- [find-room engineer] FloorPlan runtime append (scanned rooms/receivers) NOT implemented: FloorPlan.rooms/nodes are `static let` values read from many nonisolated places (Router, CrowdSimulation, canvas) and the plan is a fixed 36x22 m rect grid, so a safe runtime hook was not quick. Room scan should be treated as out of scope for Find my room this round.
- [integrator 16:33] fixed RoomScan/RoomCaptureRepresentable.swift: added @objc(CCRoomCaptureCoordinator) on Coordinator (NSCoding unstable-name build error).
- [integrator 16:34] RootView: added fourth tab "Organiser" = NavigationStack { OrganizerToolsView() }. Build currently blocked by Views/Organizer/RoomScanFile.swift:10 (MainActor static encoder used outside actor).
- [integrator] installed 16:37
- [roomplan 16:38] Compiling save point: all RoomScan/ and Views/Organizer/ files present, simulator build SUCCEEDED. Please leave @objc(CCRoomCaptureCoordinator) on Coordinator as is. No floor-plan hook exists, so no 'Add to floor plan' button.
- [integrator] installed 16:41

## Schedule engineer requests
- [schedule] RootView: add a tab **Schedule** (calendar icon) = `NavigationStack { ScheduleView() }` as the second tab. `ScheduleView` uses `@Environment(AppStore.self)`, `@Environment(AppNavigation.self)` and `@AppStorage("serverURL")`-style default; see file header.
- [schedule] Models/Ticket.swift is fine as is: `ticket.attendeeToken` (the /api/register session token) is already stored; no change needed.
- [schedule] AppNavigation (optional): add `var findTalkTitle: String?` so the navigation screen can show "To: <talk title>". ScheduleView does not reference it until it exists (see `ScheduleNav` in Views/Schedule/ScheduleNav.swift: one-line hook to flip on).
- [integrator 16:44] configured a baked-in Server URL (now removed; operators configure the origin in Settings). AppNavigation.findTalkTitle added. Schedule tab will be added to RootView once ScheduleView exists.
- [integrator] installed 16:47 (historical build used its baked-in origin).
- [find-room engineer] Final signature: `FindRoomView(initialDestinationID: String? = nil, talkTitle: String? = nil)`. Pass a FloorPlan room id (stage, room-a, room-b, lobby, lounge) and optionally the talk title; the title is only used when a room id is also given. Location sharing is gated by the existing @AppStorage("advertiseEnabled") toggle (default off): with it off there is no YOU marker, guidance or speech, only the plan, crowd and destination outline.
- [integrator] added Schedule tab (2nd); installed 16:48
- [schedule 16:49] Compiling save point, simulator build SUCCEEDED. Files: Services/ScheduleService.swift, Views/Schedule/{ScheduleView,TalkCards,ScheduleNav}.swift. Tab already present in RootView; `nav.findTalkTitle` is now set by ScheduleNav (clear it when Find my room is opened from elsewhere, or it shows a stale "To: ..."). "Add reminder" omitted: NotificationService has no per-talk method.
- [integrator] wired talkTitle into FindRoomView; installed 16:51
- [integrator] FINAL install 16:55
