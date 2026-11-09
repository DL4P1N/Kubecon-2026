import Foundation

struct WiFiNetwork: Codable, Hashable {
    var ssid: String
    var security: String
    var password: String
    var assumed: Bool?

    static let demo = WiFiNetwork(ssid: "CloudNativeHack-Guest", security: "WPA", password: "shipit-slc-2026", assumed: true)
}

struct Conference: Codable, Hashable, Identifiable {
    var slug: String
    var name: String
    var startDate: String
    var endDate: String
    var city: String
    var district: String?
    var venue: String
    var topics: [String]
    var summary: String
    var capacity: Int?
    var assumed: Bool?
    var wifi: WiFiNetwork?

    var id: String { slug }
    var network: WiFiNetwork { wifi ?? .demo }

    var startDay: Date { Conference.day(startDate) ?? .distantFuture }
    var endDay: Date { Conference.day(endDate) ?? .distantFuture }
    var isPast: Bool { endDay.addingTimeInterval(86_400) <= .now }

    var dateRange: String {
        let start = startDay.formatted(.dateTime.day().month(.abbreviated).year())
        if startDate == endDate { return start }
        return "\(startDay.formatted(.dateTime.day().month(.abbreviated))) to \(endDay.formatted(.dateTime.day().month(.abbreviated).year()))"
    }

    var place: String { "\(venue), \(city)" }

    static func day(_ string: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: string)
    }
}

enum ConferenceCatalog {
    static func load() -> [Conference] {
        guard let url = Bundle.main.url(forResource: "conferences", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode([Conference].self, from: data)
        else { return [] }
        return list.sorted { $0.startDay < $1.startDay }
    }

    static func sampleHistory() -> [Conference] {
        [
            Conference(slug: "sample-riverbend-cloud-days-2025", name: "Riverbend Cloud Days", startDate: "2025-05-14", endDate: "2025-05-15", city: "Denver", district: nil, venue: "Union Hall", topics: ["kubernetes", "observability"], summary: "Sample past conference.", capacity: nil, assumed: true, wifi: nil),
            Conference(slug: "sample-northlight-devops-2025", name: "Northlight DevOps Summit", startDate: "2025-09-09", endDate: "2025-09-10", city: "Oslo", district: nil, venue: "Fjord Centre", topics: ["gitops", "platform engineering"], summary: "Sample past conference.", capacity: nil, assumed: true, wifi: nil),
            Conference(slug: "sample-meridian-platform-2027", name: "Meridian Platform Summit", startDate: "2027-06-22", endDate: "2027-06-23", city: "Lisbon", district: nil, venue: "Docas Hall", topics: ["developer experience", "ai sre"], summary: "Sample upcoming conference.", capacity: nil, assumed: true, wifi: nil)
        ]
    }
}
