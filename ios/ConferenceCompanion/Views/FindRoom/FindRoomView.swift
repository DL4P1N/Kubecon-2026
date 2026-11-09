import SwiftUI

struct FindRoomView: View {
    /// Room id passed from a ticket ("Find my room"); nil keeps whatever is chosen already.
    var initialDestinationID: String?

    @Environment(AppStore.self) private var store
    @Environment(PositionEngine.self) private var engine
    @Environment(PhoneAdvertiser.self) private var advertiser
    @Environment(AppNavigation.self) private var nav
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("advertiseEnabled") private var advertise = false
    @AppStorage("voiceGuidance") private var voiceOn = true

    init(initialDestinationID: String? = nil) {
        self.initialDestinationID = initialDestinationID
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    venuePanel
                    SourceHeader()
                    FloorPlanCanvas(avatar: store.avatar)
                        .overlay { Rectangle().strokeBorder(Theme.line, lineWidth: 1) }
                    GuidancePanel()
                    BluetoothStatusBanner(state: engine.scanner.state, authorization: engine.scanner.authorization)
                    beaconToggle
                    calibrateLink
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .screenBackground()
            .navigationTitle("Find my room")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) { controls }
            .scrollEdgeEffectStyle(.soft, for: .bottom)
        }
        .task(id: reduceMotion) { await engine.run(reduceMotion: reduceMotion) }
        .task(id: initialDestinationID) {
            // `-findDestination <room id>` launch argument is used for screenshots.
            let id = initialDestinationID ?? UserDefaults.standard.string(forKey: "findDestination")
            if let id, !id.isEmpty { engine.setDestination(id) }
        }
        .task(id: advertise) { updateAdvertising() }
        .onChange(of: store.activeTicket?.beaconUUID) { updateAdvertising() }
        .onChange(of: engine.currentRoomID) { _, roomID in announceRoom(roomID) }
        .onChange(of: voiceOn, initial: true) {
            engine.voiceEnabled = voiceOn
            if !voiceOn { engine.voice.stop() }
        }
        .onDisappear { engine.voice.stop() }
        .sensoryFeedback(.success, trigger: engine.arrivals)
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { engine.scanner.stop() } else { engine.scanner.start() }
        }
    }

    // MARK: Venue

    @ViewBuilder
    private var venuePanel: some View {
        if let slug = nav.findSlug,
           let conference = store.tickets.first(where: { $0.conference.slug == slug })?.conference ?? store.catalog.first(where: { $0.slug == slug }) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    SectionTitle("Venue")
                    Text(conference.venue).font(.mono(.headline, weight: .semibold))
                    Text("Floor plan shows a demo layout.").font(.mono(.caption)).foregroundStyle(Theme.muted)
                }
                Spacer()
                Button("Clear venue", systemImage: "xmark.circle") { nav.findSlug = nil }
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .panel()
        }
    }

    // MARK: Floating controls

    /// Floating glass over the scrolling content: destination, then walk controls. The plan itself carries no glass.
    private var controls: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                Menu {
                    Button("No destination", systemImage: engine.destinationID.isEmpty ? "checkmark" : "circle.slash") {
                        engine.setDestination("")
                    }
                    ForEach(FloorPlan.destinations) { room in
                        Button(room.name, systemImage: room.id == engine.destinationID ? "checkmark" : "mappin") {
                            engine.setDestination(room.id)
                        }
                    }
                } label: {
                    Label(engine.destination?.shortName ?? "Choose a room", systemImage: "mappin.and.ellipse")
                        .font(.mono(.subheadline, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(Theme.background)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glassProminent)
                .tint(Theme.accent)
                .accessibilityLabel("Destination")
                .accessibilityValue(engine.destination?.name ?? "none chosen")

                if !engine.isLive {
                    Button(engine.paused ? "Start" : "Pause", systemImage: engine.paused ? "play.fill" : "pause.fill") {
                        engine.togglePaused()
                    }
                    .font(.mono(.subheadline, weight: .semibold))
                    .labelStyle(.titleAndIcon)
                    .buttonStyle(.glass)
                    .frame(minHeight: 44)
                    .accessibilityLabel(engine.paused ? "Start simulated walk" : "Pause simulated walk")

                    Button("Reset", systemImage: "arrow.counterclockwise") { engine.reset() }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.glass)
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("Reset simulated walk")
                }

                Button("Voice guidance", systemImage: voiceOn ? "speaker.wave.2.fill" : "speaker.slash.fill") { voiceOn.toggle() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.glass)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityValue(voiceOn ? "on" : "off")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: Phone beacon

    private var beaconToggle: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Let venue receivers locate this phone", isOn: $advertise)
                .font(.mono(.body))
                .frame(minHeight: 44)
                .disabled(store.activeTicket == nil)
            Text("Broadcasts a random ID tied to this ticket over Bluetooth: no name, no attendee ID.")
                .font(.mono(.footnote))
                .foregroundStyle(Theme.muted)
            if advertise, advertiser.state == .poweredOff || advertiser.state == .unauthorized {
                Text("Bluetooth is not available, so nothing is being broadcast.")
                    .font(.mono(.footnote))
                    .foregroundStyle(Theme.warn)
            }
            if store.activeTicket == nil {
                Text("Register for a conference to enable this.").font(.mono(.footnote)).foregroundStyle(Theme.warn)
            }
        }
        .panel()
    }

    private var calibrateLink: some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink {
                CalibrateView()
            } label: {
                Label("Calibrate receivers", systemImage: "slider.horizontal.3")
            }
            .buttonStyle(.ccSecondary)
            Text("\(engine.assignedInRange) of 3 assigned devices in range. Live positioning needs at least 3.")
                .font(.mono(.footnote))
                .foregroundStyle(Theme.muted)
        }
    }

    // MARK: Announcements and advertising

    private func announceRoom(_ roomID: String?) {
        // With a destination the engine announces steps (VoiceOver) or speaks them.
        guard engine.destination == nil, let room = FloorPlan.room(id: roomID) else { return }
        AccessibilityNotification.Announcement("Now in \(room.name).").post()
    }

    private func updateAdvertising() {
        if advertise, let uuid = store.activeTicket?.beaconUUID {
            advertiser.enable(uuid: uuid)
        } else {
            advertiser.disable()
        }
    }
}
