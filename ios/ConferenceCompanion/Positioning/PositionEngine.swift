import Foundation
import Observation

@MainActor @Observable
final class PositionEngine {
    let scanner = BluetoothScanner()
    let assignments = ReceiverAssignments()
    let receivers = VenueReceiver.loadBundled()

    private(set) var fix: PositionFix?
    private(set) var isLive = false
    private(set) var crowd: [CrowdPerson] = []
    private(set) var paused = false
    /// Whether directions are spoken aloud (set from the view's persisted toggle).
    var voiceEnabled = true
    @ObservationIgnored let voice = VoiceGuide()

    /// Room id the user is chosen to head for; empty when none.
    private(set) var destinationID = ""
    private(set) var guidance: Guidance?
    /// Only assigned when the room actually changes, so views reading it do not refresh every tick.
    private(set) var currentRoomID: String?
    /// Remaining distance to the destination, whole metres; nil without a destination.
    private(set) var distanceMetres: Int?
    private(set) var hasArrived = false
    /// Increments each time the user arrives; drives the success haptic.
    private(set) var arrivals = 0

    @ObservationIgnored private lazy var live = BluetoothReceivers(scanner: scanner, receivers: receivers, assignments: assignments)
    @ObservationIgnored private let simulated = SimulatedWalk()
    @ObservationIgnored private let crowdSimulation = CrowdSimulation()
    @ObservationIgnored private var clock = 0.0
    @ObservationIgnored private var lastTick: Date?

    var tag: String { isLive ? "Live Bluetooth" : "Simulated signals" }
    var currentRoom: Room? { FloorPlan.room(id: currentRoomID) }
    var destination: Room? { FloorPlan.room(id: destinationID) }
    var nextLine: String? {
        guard let guidance, destination != nil else { return nil }
        return hasArrived ? "Arrived" : "Next: \(guidance.currentStep)"
    }

    var assignedInRange: Int {
        let now = Date.now
        return assignments.map.values.filter { id in
            scanner.devices[id].map { now.timeIntervalSince($0.lastSeen) < 8 } ?? false
        }.count
    }

    func togglePaused() {
        paused.toggle()
        if paused { voice.stop() }
    }

    func setDestination(_ id: String) {
        let valid = FloorPlan.destinations.contains { $0.id == id } ? id : ""
        guard valid != destinationID else { return }
        destinationID = valid
        if valid.isEmpty { simulated.follow(nil); voice.stop() }
        guidance = nil
        hasArrived = false
        distanceMetres = nil
        refreshGuidance()
    }

    /// Back to the entrance, running, with the destination kept.
    func reset() {
        voice.stop()
        simulated.reset()
        clock = 0
        paused = false
        lastTick = nil
        guidance = nil
        hasArrived = false
        tick(reduceMotion: false)
    }

    func tick(reduceMotion: Bool) {
        let now = Date.now
        let delta = min(lastTick.map { now.timeIntervalSince($0) } ?? 0, 3)
        lastTick = now
        if let liveFix = live.fix(at: now) {
            fix = liveFix
            if !isLive { isLive = true }
            if !crowd.isEmpty { crowd = [] }
        } else {
            if isLive { isLive = false }
            if !paused || fix == nil || crowd.isEmpty {
                if !paused { clock += delta; simulated.advance(by: delta) }
                fix = simulated.fix(at: now)
                crowd = crowdSimulation.people(clock: clock, reduceMotion: reduceMotion)
            }
        }
        refreshGuidance()
    }

    func run(reduceMotion: Bool) async {
        scanner.start()
        lastTick = nil
        while !Task.isCancelled {
            tick(reduceMotion: reduceMotion)
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 2000 : 100))
        }
    }

    private func refreshGuidance() {
        let point = fix?.point
        let roomID = point.flatMap { FloorPlan.room(at: $0)?.id }
        if roomID != currentRoomID { currentRoomID = roomID }
        guard let point, let destination else {
            if guidance != nil { guidance = nil }
            if distanceMetres != nil { distanceMetres = nil }
            if hasArrived { hasArrived = false }
            return
        }

        var current = guidance
        let previousProgress = guidance?.progress
        let isNewDestination = current == nil || current?.destinationID != destination.id
        let needsRoute = current == nil || current?.destinationID != destination.id
            || ((current?.nearestSegment(to: point).distance ?? 0) > 4.5 && roomID != destination.id)
        if needsRoute {
            guard let route = Router.route(from: point, to: destination), route.points.count >= 1 else { return }
            current = Guidance(
                destinationID: destination.id, points: route.points, steps: route.steps,
                segmentOffset: route.points.count - route.nodePoints.count, segment: 0
            )
            if !isLive { simulated.follow(Array(route.points.dropFirst())) }
        }
        guard var next = current else { return }

        let arrivedNow = roomID == destination.id
        next.segment = arrivedNow ? max(0, next.points.count - 1) : next.nearestSegment(to: point).index
        if next != guidance { guidance = next }
        if !arrivedNow {
            if needsRoute {
                let first = next.currentStep
                voice.speak(
                    isNewDestination ? SpeechSentences.start(room: destination.name, firstStep: first) : SpeechSentences.reroute(firstStep: first),
                    enabled: voiceEnabled
                )
            } else if let previousProgress, previousProgress != next.progress {
                voice.speak(SpeechSentences.next(step: next.currentStep), enabled: voiceEnabled)
            }
        }

        let metres = arrivedNow ? 0 : Int(next.remainingDistance(from: point).rounded())
        if metres != distanceMetres { distanceMetres = metres }
        if arrivedNow != hasArrived {
            hasArrived = arrivedNow
            if arrivedNow {
                arrivals += 1
                voice.speak(SpeechSentences.arrival(room: destination.name), enabled: voiceEnabled)
            }
        }
    }
}
