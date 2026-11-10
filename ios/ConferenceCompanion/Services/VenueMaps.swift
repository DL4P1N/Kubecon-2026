import CoreLocation
import MapKit

@MainActor
enum VenueMaps {
    /// Geocodes "venue, city" and opens Apple Maps; Maps lets the user pick driving or transit.
    static func open(_ conference: Conference) async -> Bool {
        let query = "\(conference.venue), \(conference.city)"
        guard let placemark = try? await CLGeocoder().geocodeAddressString(query).first else { return false }
        let item = MKMapItem(placemark: MKPlacemark(placemark: placemark))
        item.name = conference.venue
        item.openInMaps(launchOptions: nil)
        return true
    }

    static func fallbackURL(_ conference: Conference) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [URLQueryItem(name: "daddr", value: "\(conference.venue), \(conference.city)")]
        return components?.url
    }
}
