import Foundation

struct Route: Equatable {
    var points: [CGPoint]
    var steps: [String]
    var length: Double
    /// Graph nodes on the path, in order (excludes the start point).
    var nodeIDs: [String] = []
    var nodePoints: [CGPoint] = []
}

/// Dijkstra over the small node graph in `FloorPlan`.
enum Router {
    static func route(from start: CGPoint, to destination: Room) -> Route? {
        guard let startNode = FloorPlan.nearestNode(to: start), let goalID = destination.nodeID else { return nil }
        guard let path = shortestPath(from: startNode.id, to: goalID) else { return nil }
        let nodes = path.compactMap { FloorPlan.node($0) }
        guard nodes.count == path.count else { return nil }

        var points = [start] + nodes.map(\.point)
        var steps: [String] = []
        var total = hypot(start.x - nodes[0].point.x, start.y - nodes[0].point.y)
        if nodes.count == 1 {
            steps.append("You are in \(destination.name).")
        }
        for index in 0..<max(0, nodes.count - 1) {
            let from = nodes[index], to = nodes[index + 1]
            let distance = hypot(to.point.x - from.point.x, to.point.y - from.point.y)
            total += distance
            let direction = compass(from.point, to.point)
            let metres = Int(distance.rounded())
            switch (from.isRoom, to.isRoom) {
            case (true, false): steps.append("Leave \(from.name) and head \(direction) \(metres) m to the \(to.name).")
            case (false, false): steps.append("Walk \(direction) \(metres) m along the hallway to the \(to.name).")
            case (false, true): steps.append("Go \(direction) \(metres) m into \(to.name).")
            case (true, true): steps.append("Walk \(direction) \(metres) m to \(to.name).")
            }
        }
        if nodes.count > 1 { steps.append("You have arrived at \(destination.name).") }
        if points.count > 1, points[0] == points[1] { points.removeFirst() }
        return Route(points: points, steps: steps, length: total, nodeIDs: path, nodePoints: nodes.map(\.point))
    }

    static func shortestPath(from start: String, to goal: String) -> [String]? {
        var adjacency: [String: [(String, Double)]] = [:]
        for (a, b) in FloorPlan.edges {
            guard let na = FloorPlan.node(a), let nb = FloorPlan.node(b) else { continue }
            let weight = hypot(na.point.x - nb.point.x, na.point.y - nb.point.y)
            adjacency[a, default: []].append((b, weight))
            adjacency[b, default: []].append((a, weight))
        }
        var distance: [String: Double] = [start: 0]
        var previous: [String: String] = [:]
        var unvisited = Set(FloorPlan.nodes.map(\.id))
        while let current = unvisited.filter({ distance[$0] != nil }).min(by: { distance[$0, default: .infinity] < distance[$1, default: .infinity] }) {
            unvisited.remove(current)
            if current == goal { break }
            for (next, weight) in adjacency[current] ?? [] where unvisited.contains(next) {
                let candidate = distance[current, default: .infinity] + weight
                if candidate < distance[next, default: .infinity] {
                    distance[next] = candidate
                    previous[next] = current
                }
            }
        }
        guard distance[goal] != nil else { return nil }
        var path = [goal]
        while let step = previous[path[0]] { path.insert(step, at: 0) }
        return path.first == start ? path : nil
    }

    static func compass(_ a: CGPoint, _ b: CGPoint) -> String {
        let dx = b.x - a.x, dy = b.y - a.y
        if abs(dx) > abs(dy) { return dx > 0 ? "east" : "west" }
        return dy > 0 ? "south" : "north"
    }
}
