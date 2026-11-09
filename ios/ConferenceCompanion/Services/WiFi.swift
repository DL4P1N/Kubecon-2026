import Foundation
import NetworkExtension

enum WiFiPayload {
    private static let backslash = Character(UnicodeScalar(92))
    private static let special: Set<Character> = [Character(UnicodeScalar(92)), ";", ",", ":", "\""]

    static func escape(_ text: String) -> String {
        var out = ""
        for character in text {
            if special.contains(character) { out.append(backslash) }
            out.append(character)
        }
        return out
    }

    static func string(for network: WiFiNetwork) -> String {
        let type: String
        switch network.security.uppercased() {
        case "NONE", "OPEN", "": type = "nopass"
        case "WEP": type = "WEP"
        default: type = "WPA"
        }
        if type == "nopass" { return "WIFI:T:nopass;S:\(escape(network.ssid));;" }
        return "WIFI:T:\(type);S:\(escape(network.ssid));P:\(escape(network.password));;"
    }
}

enum WiFiJoinResult: Equatable {
    case joined
    case cancelled
    case failed(String)
}

@MainActor
enum WiFiJoiner {
    static func join(_ network: WiFiNetwork) async -> WiFiJoinResult {
        let open = ["NONE", "OPEN", ""].contains(network.security.uppercased())
        let configuration = open
            ? NEHotspotConfiguration(ssid: network.ssid)
            : NEHotspotConfiguration(ssid: network.ssid, passphrase: network.password, isWEP: network.security.uppercased() == "WEP")
        do {
            try await NEHotspotConfigurationManager.shared.apply(configuration)
            return .joined
        } catch {
            let nsError = error as NSError
            if nsError.domain == NEHotspotConfigurationErrorDomain {
                switch nsError.code {
                case NEHotspotConfigurationError.alreadyAssociated.rawValue: return .joined
                case NEHotspotConfigurationError.userDenied.rawValue: return .cancelled
                default: break
                }
            }
            return .failed(nsError.localizedDescription)
        }
    }
}
