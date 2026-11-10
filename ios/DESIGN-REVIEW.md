# Design review (simulator, iPhone 18 Pro Max, default Dynamic Type)

Reviewed tree at about 4:27 PM, before the Tickets redesign. Tokens and helpers live in `ConferenceCompanion/Theme/`
(`.ccCard()`, `.ccChip(selected:)`, `.ccText(_:)`, `.buttonStyle(.ccPrimary/.ccSecondary)`, `glassControlGroup`, `.ccGlassButton(prominent:)`).
Screenshots: /private/tmp/claude-501/-Users-erickwhatcott-Downloads-Kubecon-2026/fc97e951-15c4-40a4-a661-1a1c36d70930/scratchpad/ios/review/ (03/11-ticket, 10-find, 11-profile, 01-first).
Status key: [open] / [fixed]. Re-review marks are appended at the bottom.

## Cross-cutting (integrator)
- [open] Project setting: add `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor` (see INTEGRATION.md). Without it, toggles, links and system controls fall back to blue.
- [open] Views/**: titles and body copy are all `.font(.mono(...))`. The site uses a grotesk for titles/body and mono only for labels/data. Use `.ccTitle()`/`.ccHeadline()`/`.ccBody()` for names, titles and sentences; keep mono for codes, times, labels. Long mono paragraphs read poorly and wrap early.

## Tickets
- [fixed 4:35] Views/Tickets/TicketDetailView.swift (actionCluster): four-to-five glass buttons in two rows float over the detail card in the first viewport, hiding Date/Venue text and touching the tab bar. Fix: keep two floating actions (Directions prominent, Find my room), move Join Wi-Fi / Open in browser / Wallet into the content as `.buttonStyle(.ccSecondary)` rows.
- [fixed 4:35] TicketDetailView.swift: "Directions to the venue" wraps to two lines inside the prominent glass pill. Fix: label "Directions", or drop the mono font on glass buttons (`.font(.subheadline.weight(.semibold))`).
- [fixed 4:35] TicketDetailView.swift detail card: name is `.mono(.title2, .bold)` and role is lime body text; role in lime competes with the lime action. Fix: name `.ccTitle()`, role `.ccBody()` in `Theme.muted`.
- [open] Tag(tone: .warn) on a Demo ticket uses amber (warning colour) for a normal state, giving amber + lime + white on one screen. Fix: use `.muted` for Demo, keep amber for real warnings.
- [fixed 4:35] Views/Tickets/RegisterView.swift InterestChips: hand-rolled chips (lime border + lime text unselected, lime fill selected) so selected vs unselected barely differ. Fix: `Text(option).ccChip(selected: isOn)`.
- [open] TicketsView.swift emptyState: title in mono; one prominent `.cc` button is correct, keep it as the only prominent action.

## Find my room
- [open] Views/FindRoom/FindRoomView.swift: "Calibrate receivers" is a hand-built full-width lime outline that competes with the prominent glass "Choose a room". Fix: `.buttonStyle(.ccSecondary)`.
- [open] Views/FindRoom/FloorPlanCanvas.swift: receivers use a custom teal (`Self.teal`), a second accent next to lime and amber. Fix: draw receivers in `Theme.muted` / `Theme.lineStrong` squares and pulse in lime only when active.
- [fixed 4:35] FindRoomView.swift: the floating glass bar (Choose a room / Pause / reset) sits over scrolling text at the bottom, so lines show through the glass. Fix: add `.contentMargins(.bottom, 96, for: .scrollContent)` and `.scrollEdgeEffectStyle(.soft, for: .bottom)` so content fades under the controls.
- [open] FloorPlanCanvas.swift labels are fixed 8-11 pt monospaced (do not scale with Dynamic Type); acceptable for a map, but "YOU" at 8 pt is near the legibility floor. Fix: minimum 10 pt.
- [open] FindRoomView.swift: the amber SIMULATED SIGNALS tag plus an amber-bordered tag style is fine (it is a real caveat); keep it the only amber on the screen.

## Profile
- [open] Views/Profile/ProfileView.swift: placeholder text in the Name/Role/Add fields is very low contrast on the dark fill. Fix: `TextField(prompt: Text("Name").foregroundStyle(Theme.muted))` and a `Theme.lineStrong` border.
- [open] ProfileView.swift Invite section: one `.cc` (solid lime) button per conference, so several prominent actions on one screen. Fix: first one `.ccPrimary`, rest `.ccSecondary`.
- [open] Views/Profile/ProfileView.swift interest chips: custom outline chips; use `.ccChip(selected: true)` with a trailing xmark.
- [open] Views/Profile/AvatarEditor.swift: "Reset character" renders as a dim lime outline (reads disabled even when enabled); swatch selection uses a white ring while chips use lime. Fix: `.ccSecondary`; selected swatch ring `Theme.accent`.
- [open] ProfileView.swift: long form with no grouping; wrap Name/Role in one `.ccCard()` and put CCSectionLabel above each group.

## What already works
- Tab bar and nav controls are system glass (correct); content cards are flat 1 px sharp (correct).
- Prominent glass button with lime tint and dark ink compiles and renders with good contrast.
- Tag/panel/section labels consistent with the website palette.

## Re-review at 4:35 PM (static, from the tree; a simulator build was blocked by a compile error in RoomScan/RoomCaptureRepresentable.swift:31 "Duplicate attribute", not a Theme or Tickets problem)
- Fixed: ticket pass redesign uses system titles, one prominent glass action (Find my room today / Directions otherwise), compact icon actions, \`.ccChip\` on interest chips, \`.scrollEdgeEffectStyle(.soft, for: .bottom)\` on Find.
- Still open: Tag(.warn) for Demo ticket in TicketPassView.swift:83 (amber for a non-warning); Calibrate receivers outline FindRoomView.swift:171 -> \`.ccSecondary\`; teal receivers FloorPlanCanvas.swift:12; Profile placeholder contrast and per-conference \`.cc\` Invite buttons ProfileView.swift:84; AvatarEditor.swift:52 white swatch ring; project AccentColor setting.
- Not reviewed visually: new TicketPassView/TicketShape pass card, Organizer/** screens, RoomScan. Please screenshot them in the revision round.
