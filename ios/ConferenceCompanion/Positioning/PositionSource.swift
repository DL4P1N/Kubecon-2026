import Foundation

struct VenueReceiver: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let x: Double
    let y: Double

    var point: CGPoint { CGPoint(x: x, y: y) }

    static func loadBundled() -> [VenueReceiver] {
        guard let url = Bundle.main.url(forResource: "receivers", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode([VenueReceiver].self, from: data)
        else { return [] }
        return list
    }
}

@MainActor
protocol PositionSource: AnyObject {
    var tag: String { get }
    func fix(at date: Date) -> PositionFix?
}
