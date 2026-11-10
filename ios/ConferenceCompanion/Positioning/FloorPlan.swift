import Foundation

struct Room: Identifiable, Hashable {
    let id: String
    let name: String
    let shortName: String
    /// Metres; x east, y south.
    let rect: CGRect
    let nodeID: String?
}

struct PlanNode: Hashable {
    let id: String
    let name: String
    let point: CGPoint
    let isRoom: Bool
}

/// Names mirror landing/scene/layout.js: keynote hall, breakouts, lounge, hallway, lobby.
enum FloorPlan {
    static let size = CGSize(width: 36, height: 22)

    static let rooms: [Room] = [
        Room(id: "stage", name: "Main Stage", shortName: "Main Stage", rect: CGRect(x: 0, y: 0, width: 14, height: 10), nodeID: "n-stage"),
        Room(id: "room-a", name: "Breakout A", shortName: "Breakout A", rect: CGRect(x: 14, y: 0, width: 11, height: 10), nodeID: "n-a"),
        Room(id: "room-b", name: "Breakout B", shortName: "Breakout B", rect: CGRect(x: 25, y: 0, width: 11, height: 10), nodeID: "n-b"),
        Room(id: "hallway", name: "Hallway", shortName: "Hallway", rect: CGRect(x: 0, y: 10, width: 36, height: 4), nodeID: nil),
        Room(id: "lobby", name: "Lobby and Registration", shortName: "Lobby / Reg", rect: CGRect(x: 0, y: 14, width: 14, height: 8), nodeID: "n-lobby"),
        Room(id: "lounge", name: "Lounge", shortName: "Lounge", rect: CGRect(x: 14, y: 14, width: 22, height: 8), nodeID: "n-lounge")
    ]

    static var destinations: [Room] { rooms.filter { $0.id != "hallway" } }

    static let nodes: [PlanNode] = [
        PlanNode(id: "n-stage", name: "Main Stage", point: CGPoint(x: 7, y: 5), isRoom: true),
        PlanNode(id: "n-a", name: "Breakout A", point: CGPoint(x: 19.5, y: 5), isRoom: true),
        PlanNode(id: "n-b", name: "Breakout B", point: CGPoint(x: 30.5, y: 5), isRoom: true),
        PlanNode(id: "n-lobby", name: "Lobby and Registration", point: CGPoint(x: 7, y: 18), isRoom: true),
        PlanNode(id: "n-lounge", name: "Lounge", point: CGPoint(x: 25, y: 18), isRoom: true),
        PlanNode(id: "h-stage", name: "Main Stage door", point: CGPoint(x: 7, y: 12), isRoom: false),
        PlanNode(id: "h-a", name: "Breakout A door", point: CGPoint(x: 19.5, y: 12), isRoom: false),
        PlanNode(id: "h-lounge", name: "Lounge door", point: CGPoint(x: 25, y: 12), isRoom: false),
        PlanNode(id: "h-b", name: "Breakout B door", point: CGPoint(x: 30.5, y: 12), isRoom: false)
    ]

    static let edges: [(String, String)] = [
        ("n-stage", "h-stage"), ("n-lobby", "h-stage"), ("n-a", "h-a"), ("n-lounge", "h-lounge"), ("n-b", "h-b"),
        ("h-stage", "h-a"), ("h-a", "h-lounge"), ("h-lounge", "h-b")
    ]

    static func node(_ id: String) -> PlanNode? { nodes.first { $0.id == id } }

    static func room(at point: CGPoint) -> Room? {
        rooms.first { $0.rect.contains(point) }
    }

    static func room(id: String?) -> Room? { rooms.first { $0.id == id } }

    static func nearestNode(to point: CGPoint) -> PlanNode? {
        if let room = room(at: point), let nodeID = room.nodeID { return node(nodeID) }
        return nodes.min { hypot($0.point.x - point.x, $0.point.y - point.y) < hypot($1.point.x - point.x, $1.point.y - point.y) }
    }
}
