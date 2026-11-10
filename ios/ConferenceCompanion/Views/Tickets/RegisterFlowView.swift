import SwiftUI

struct RegisterFlowView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage("serverURL") private var serverURL = ""
    let onRegistered: (UUID) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Pick a conference").ccDisplay()
                        Text("You get a QR ticket for room doors.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                    }
                    if store.catalog.allSatisfy(\.isPast) {
                        Text("No upcoming conferences in the catalogue. Pull down to refresh.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                    }
                    ForEach(store.catalog.filter { !$0.isPast }) { conference in
                        NavigationLink(value: conference) {
                            HStack(alignment: .center, spacing: 12) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(conference.name)
                                        .font(.system(.headline, weight: .semibold))
                                        .foregroundStyle(Theme.ink)
                                        .multilineTextAlignment(.leading)
                                    Text("\(conference.dateRange) · \(conference.city)")
                                        .font(.mono(.footnote))
                                        .monospacedDigit()
                                        .foregroundStyle(Theme.muted)
                                    if conference.assumed == true {
                                        Tag(text: "Assumed details", tone: .muted)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(Theme.muted)
                                    .accessibilityHidden(true)
                            }
                            .ccCard()
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
            .refreshable { await store.refreshCatalogue(serverURL: serverURL) }
            .screenBackground()
            .navigationTitle("Register")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Conference.self) { RegisterView(conference: $0, onRegistered: onRegistered) }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}
