import Foundation

struct APIClient: Sendable {
    struct Failure: Error, LocalizedError {
        let message: String
        var status: Int?
        var errorDescription: String? { message }
    }

    struct RegisterResponse: Decodable { let attendeeId: String; let token: String; let expiresAt: String }
    struct AccessResponse: Decodable { let token: String; let expiresAt: String }

    private struct RegisterBody: Encodable {
        struct Consent: Encodable { let clusterMap = true; let qrCheckin = true }
        let name: String
        let email = ""
        let interests: [String]
        let consent = Consent()
        let conference: String
    }

    let base: URL

    /// Short timeouts: a dead server must not hold up the demo; the caller falls back to a Demo ticket.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 10
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    init?(string: String) {
        var text = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host() != nil else { return nil }
        base = url
    }

    func register(name: String, interests: [String], conference: String) async throws -> RegisterResponse {
        try await post("api/register", body: RegisterBody(name: name, interests: interests, conference: conference), bearer: nil)
    }

    func accessToken(bearer: String) async throws -> AccessResponse {
        try await post("api/access/token", body: [String: String](), bearer: bearer)
    }

    /// GET <base>/<path> as a conference list. Throws on non-200, HTML, or an empty list.
    func fetchCatalogue(path: String) async throws -> [Conference] {
        let request = URLRequest(url: base.appending(path: path), timeoutInterval: 6)
        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw Failure(message: "HTTP error from /\(path)", status: (response as? HTTPURLResponse)?.statusCode)
        }
        let list = try JSONDecoder().decode([Conference].self, from: data)
        guard !list.isEmpty else { throw Failure(message: "Empty catalogue") }
        return list
    }

    /// A static host has no API: 404/405 or an HTML page instead of JSON.
    static func isMissingEndpoint(_ error: Error) -> Bool {
        if let failure = error as? Failure, let status = failure.status { return status == 404 || status == 405 }
        return error is DecodingError
    }

    private func post<Body: Encodable, Response: Decodable>(_ path: String, body: Body, bearer: String?) async throws -> Response {
        var request = URLRequest(url: base.appending(path: path), timeoutInterval: 6)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "authorization") }
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw Failure(message: "HTTP \(code) from /\(path)", status: code)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

enum ISODate {
    static func parse(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}
