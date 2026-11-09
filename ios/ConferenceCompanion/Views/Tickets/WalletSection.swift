import PassKit
import SwiftUI

private struct PassItem: Identifiable {
    let id = UUID()
    let pass: PKPass
}

/// "Add to Apple Wallet" appears only when this device can add passes and a signed pass really
/// exists on the server. Renders nothing otherwise. Styled as a glass control for the floating cluster.
struct WalletSection: View {
    let slug: String
    let serverURL: String
    @State private var available = false
    @State private var item: PassItem?
    @State private var message: String?
    @State private var isLoading = false

    private var passURL: URL? {
        APIClient(string: serverURL)?.base.appending(path: "site/passes/\(slug).pkpass")
    }

    var body: some View {
        Group {
            if available {
                Button {
                    download()
                } label: {
                    if isLoading {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 36)
                    } else {
                        Label("Wallet", systemImage: "wallet.pass")
                    }
                }
                .ccGlassButton()
                .disabled(isLoading)
                .accessibilityLabel("Add to Apple Wallet")
                .accessibilityHint(message ?? "Adds this ticket to the Wallet app")
            }
        }
        .task(id: "\(serverURL)|\(slug)") { available = await probe() }
        .sheet(item: $item) { AddPassSheet(pass: $0.pass).ignoresSafeArea() }
        .alert("Could not load the pass", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
    }

    private func probe() async -> Bool {
        guard PKAddPassesViewController.canAddPasses(), let url = passURL else { return false }
        var request = URLRequest(url: url, timeoutInterval: 6)
        request.httpMethod = "HEAD"
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("application/vnd.apple.pkpass") == true
        else { return false }
        return true
    }

    private func download() {
        guard let url = passURL else { return }
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                item = PassItem(pass: try PKPass(data: data))
            } catch {
                message = error.localizedDescription
            }
        }
    }
}

private struct AddPassSheet: UIViewControllerRepresentable {
    let pass: PKPass

    func makeUIViewController(context: Context) -> UIViewController {
        let controller: UIViewController? = PKAddPassesViewController(pass: pass)
        return controller ?? UIViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}
