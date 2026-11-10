import AVFoundation
import Foundation
import OSLog
import SwiftUI

/// Speaks directions with one long-lived synthesizer. While VoiceOver is running it posts an announcement instead.
@MainActor
final class VoiceGuide: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private let log = Logger(subsystem: "ConferenceCompanion", category: "voice")
    private(set) var startedCount = 0

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String, enabled: Bool) {
        if UIAccessibility.isVoiceOverRunning {
            AccessibilityNotification.Announcement(text).post()
            return
        }
        guard enabled else { return }
        // Never queue: a new instruction replaces the one being spoken.
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .word) }
        activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
            ?? AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    func stop() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        deactivateSession()
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
        try? session.setActive(true)
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func finishedIfIdle() {
        if !synthesizer.isSpeaking { deactivateSession() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in
            startedCount += 1
            log.info("didStart \(self.startedCount)")
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in finishedIfIdle() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in finishedIfIdle() }
    }
}
