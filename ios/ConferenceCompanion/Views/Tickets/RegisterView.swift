import SwiftUI

struct RegisterView: View {
    @Environment(AppStore.self) private var store
    @AppStorage("serverURL") private var serverURL = ""
    let conference: Conference
    let onRegistered: (UUID) -> Void

    @State private var name = ""
    @State private var role = ""
    @State private var selected: Set<String> = []
    @State private var custom: [String] = []
    @State private var customText = ""
    @State private var isWorking = false
    @State private var showNameError = false
    @State private var done = 0
    @State private var step = 1
    @FocusState private var focus: Field?

    private enum Field { case name, role, custom }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(step) of 2").ccLabel().monospacedDigit().accessibilityLabel("Step \(step) of 2")
                    Text(step == 1 ? "Who you are" : "What you want to hear about").ccDisplay()
                    Text("\(conference.name) · \(conference.dateRange) · \(conference.place)")
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Theme.muted)
                }
                if step == 1 { whoStep } else { interestsStep }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .sensoryFeedback(.success, trigger: done)
        .onChange(of: name) { if showNameError, !trimmedName.isEmpty { showNameError = false } }
        .screenBackground()
        .navigationTitle("Register")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { primaryBar }
        .onAppear {
            if name.isEmpty { name = store.profile.name }
            if role.isEmpty { role = store.profile.role }
            if selected.isEmpty {
                selected = Set(store.profile.interests.filter { conference.topics.contains($0) })
                custom = store.profile.interests.filter { !conference.topics.contains($0) }
                selected.formUnion(custom)
            }
        }
    }

    private var whoStep: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(spacing: 0) {
                field("Name", text: $name, content: .name, focus: .name, next: .role)
                Rectangle().fill(Theme.line).frame(height: Theme.hairline)
                field("Role (optional)", text: $role, content: .jobTitle, focus: .role, next: nil)
            }
            .ccCard(padding: 0)
            if showNameError {
                Text("Add your name so the ticket can show it.")
                    .font(.footnote)
                    .foregroundStyle(Theme.down)
                    .accessibilityLabel("Error: add your name so the ticket can show it.")
            }
        }
    }

    private var interestsStep: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Interests").ccLabel().accessibilityAddTraits(.isHeader)
                InterestChips(options: conference.topics + custom, selected: $selected)
            }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    TextField("Add your own", text: $customText)
                        .font(.body)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .custom)
                        .submitLabel(.done)
                        .onSubmit(addCustom)
                    Button("Add", action: addCustom)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(customText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
            }
            .ccCard(padding: 0)
            Text(serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                 ? "No server set. You will get a ticket labelled Demo ticket."
                 : "Registers with \(serverURL). If it is unreachable you get a Demo ticket instead.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
        }
    }

    private var primaryBar: some View {
        VStack(spacing: 8) {
            if step == 2 {
                Button("Back") { focus = nil; step = 1 }
                    .buttonStyle(.ccSecondary)
                    .disabled(isWorking)
            }
            Button {
                if step == 1 { advance() } else { submit() }
            } label: {
                if isWorking { ProgressView().tint(Theme.background) } else { Text(step == 1 ? "Continue" : "Get my ticket") }
            }
            .buttonStyle(.ccPrimary)
            .disabled(isWorking)
            .accessibilityLabel(isWorking ? "Registering" : (step == 1 ? "Continue" : "Get my ticket"))
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(Theme.background.opacity(0.94))
    }

    private func advance() {
        guard !trimmedName.isEmpty else {
            showNameError = true
            focus = .name
            return
        }
        focus = nil
        step = 2
    }

    private func field(_ title: String, text: Binding<String>, content: UITextContentType, focus field: Field, next: Field?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).ccLabel()
            TextField(title, text: text)
                .font(.body)
                .textContentType(content)
                .focused($focus, equals: field)
                .submitLabel(next == nil ? .done : .next)
                .onSubmit { focus = next }
                .frame(minHeight: 28)
        }
        .padding(16)
    }

    private func addCustom() {
        let value = customText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !value.isEmpty else { return }
        if !conference.topics.contains(value), !custom.contains(value) { custom.append(value) }
        selected.insert(value)
        customText = ""
    }

    private func submit() {
        guard !trimmedName.isEmpty else {
            showNameError = true
            focus = .name
            return
        }
        focus = nil
        isWorking = true
        let options = conference.topics + custom
        let interests = options.filter { selected.contains($0) }
        Task {
            let id = await store.register(
                conference, name: trimmedName, role: role.trimmingCharacters(in: .whitespaces),
                interests: interests, serverURL: serverURL
            )
            isWorking = false
            done += 1
            onRegistered(id)
        }
    }
}

struct InterestChips: View {
    let options: [String]
    @Binding var selected: Set<String>

    var body: some View {
        FlowLayout {
            ForEach(options, id: \.self) { option in
                let isOn = selected.contains(option)
                Button {
                    if isOn { selected.remove(option) } else { selected.insert(option) }
                } label: {
                    Text(option)
                        .ccChip(selected: isOn)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isOn ? .isSelected : [])
            }
        }
    }
}
