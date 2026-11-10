import Foundation

/// Pure, deterministic wording for spoken directions. Steps come from `Router` ("Walk east 13 m along ...").
enum SpeechSentences {
    static func start(room: String, talk: String? = nil, firstStep: String) -> String {
        let target = talk.map { "\($0) in \(room)" } ?? room
        return "Starting route to \(target). \(spoken(step: firstStep))"
    }

    static func reroute(firstStep: String) -> String {
        "Rerouting. \(spoken(step: firstStep))"
    }

    static func next(step: String) -> String {
        let text = spoken(step: step)
        return "Next, \(text.prefix(1).lowercased())\(text.dropFirst())"
    }

    static func arrival(room: String, talk: String? = nil) -> String {
        talk.map { "You have arrived at \(room) for \($0)." } ?? "You have arrived at \(room)."
    }

    /// "Walk east 13 m along the hallway" becomes "Walk east about 15 metres along the hallway".
    static func spoken(step: String) -> String {
        var result = ""
        var index = step.startIndex
        while index < step.endIndex {
            if step[index].isNumber, index == step.startIndex || !step[step.index(before: index)].isLetter {
                var end = index
                while end < step.endIndex, step[end].isNumber { end = step.index(after: end) }
                let suffix = step[end...]
                if suffix.hasPrefix(" m"), let metres = Int(step[index..<end]),
                   suffix.dropFirst(2).first.map({ !$0.isLetter }) ?? true {
                    result += "about \(roundedMetres(metres)) \(roundedMetres(metres) == 1 ? "metre" : "metres")"
                    index = step.index(end, offsetBy: 2)
                    continue
                }
            }
            result.append(step[index])
            index = step.index(after: index)
        }
        return result
    }

    /// Whole metres below 10, nearest 5 above.
    static func roundedMetres(_ metres: Int) -> Int {
        metres < 10 ? max(metres, 1) : Int((Double(metres) / 5).rounded()) * 5
    }
}
