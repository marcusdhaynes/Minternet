import SwiftUI
import WebKit

// Minternet iOS uses the system WKWebView instead of embedding a second browser engine.
// Private tabs use WKWebsiteDataStore.nonPersistent(), never shared with normal tabs.
@MainActor
final class BrowserState: ObservableObject {
    final class Tab: Identifiable {
        let id = UUID()
        var title: String = "New Tab"
        var url: URL?
        let isPrivate: Bool
        let webView: WKWebView

        init(isPrivate: Bool) {
            self.isPrivate = isPrivate
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = isPrivate ? .nonPersistent() : .default()
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            webView = WKWebView(frame: .zero, configuration: configuration)
            webView.allowsBackForwardNavigationGestures = true
            webView.scrollView.contentInsetAdjustmentBehavior = .never
        }
    }

    @Published var tabs: [Tab] = []
    @Published var selectedId: UUID?
    @Published var address: String = ""
    @Published var message: String?

    init() { newTab() }

    var active: Tab? { tabs.first(where: { $0.id == selectedId }) }

    func newTab(privateMode: Bool = false, load: URL? = nil) {
        guard tabs.count < 25 else {
            message = "Maximum 25 open tabs."
            return
        }
        let tab = Tab(isPrivate: privateMode)
        tabs.append(tab)
        selectedId = tab.id
        address = load?.absoluteString ?? ""
        if let load { tab.webView.load(URLRequest(url: load)) }
    }

    func select(_ id: UUID) {
        selectedId = id
        let tab = active
        address = tab?.webView.url?.absoluteString ?? tab?.url?.absoluteString ?? ""
    }

    func close(_ id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[index].webView.stopLoading()
        tabs.remove(at: index)
        if tabs.isEmpty { newTab(); return }
        if selectedId == id { select(tabs[min(index, tabs.count - 1)].id) }
    }

    func switchPrivacy() {
        guard let tab = active,
              let index = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        let destination = tab.webView.url ?? tab.url
        tab.webView.stopLoading()
        let replacement = Tab(isPrivate: !tab.isPrivate)
        tabs[index] = replacement
        selectedId = replacement.id
        if let destination, destination.scheme == "https" {
            replacement.webView.load(URLRequest(url: destination))
            address = destination.absoluteString
        } else {
            address = ""
        }
        // Switching normal -> private NEVER erases data already saved by normal mode.
    }

    func navigate(_ input: String) {
        guard let tab = active else { return }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        let target: String
        if text.lowercased().hasPrefix("https://") {
            target = text
        } else if text.contains("://") || text.contains(":") {
            message = "Blocked non-HTTPS navigation."
            return
        } else if text.contains(".") && !text.contains(" ") {
            target = "https://" + text
        } else {
            var parts = URLComponents()
            parts.scheme = "https"
            parts.host = "duckduckgo.com"
            parts.path = "/"
            parts.queryItems = [URLQueryItem(name: "q", value: text)]
            target = parts.url?.absoluteString ?? ""
        }
        guard let url = URL(string: target),
              url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil else {
            message = "The address is not a valid HTTPS website."
            return
        }
        tab.url = url
        tab.webView.load(URLRequest(url: url))
        address = url.absoluteString
    }

    func update(_ webView: WKWebView) {
        guard let tab = active, tab.webView === webView else { return }
        address = webView.url?.absoluteString ?? ""
        tab.title = (webView.title?.isEmpty == false) ? webView.title! : (webView.url?.host ?? "New Tab")
        objectWillChange.send()
    }
}

struct SecureWebView: UIViewRepresentable {
    @ObservedObject var state: BrowserState
    let tab: BrowserState.Tab

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        let state: BrowserState
        init(_ state: BrowserState) { self.state = state }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = action.request.url
            // Block non-HTTPS main-frame navigations; subresources remain governed by ATS.
            if action.targetFrame?.isMainFrame != false,
               let scheme = url?.scheme?.lowercased(),
               scheme != "https" && !(scheme == "about" && url?.absoluteString == "about:blank") {
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in state.update(webView) }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in state.message = "Navigation failed: \(error.localizedDescription)" }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            Task { @MainActor in state.message = "Connection failed: \(error.localizedDescription)" }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = action.request.url, url.scheme == "https" else { return nil }
            // OAuth and login popups open as another Minternet tab instead of Safari.
            Task { @MainActor in state.newTab(privateMode: state.active?.isPrivate ?? false, load: url) }
            return nil
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(state) }
    func makeUIView(context: Context) -> WKWebView {
        let view = tab.webView
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

struct ContentView: View {
    @StateObject private var state = BrowserState()
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 3) {
                    ForEach(state.tabs) { tab in
                        HStack(spacing: 3) {
                            Button(action: { state.select(tab.id) }) {
                                HStack(spacing: 3) {
                                    if tab.isPrivate { Image(systemName: "eye.slash.fill") }
                                    Text(tab.title)
                                        .lineLimit(1)
                                        .frame(maxWidth: 100)
                                }
                            }
                            .accessibilityIdentifier("tab-\(tab.id)")
                            Button("×") { state.close(tab.id) }
                                .accessibilityLabel("Close \(tab.title)")
                        }
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .frame(height: 25)
                        .background(tab.id == state.selectedId ? Color.indigo.opacity(0.55) : Color.white.opacity(0.10))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    Button(action: { state.newTab() }) {
                        Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                    }.accessibilityIdentifier("new-tab")
                }
                .padding(.horizontal, 5)
            }
            .frame(height: 30)
            HStack(spacing: 7) {
                Button(action: { state.active?.webView.goBack() }) { Image(systemName: "chevron.left") }
                    .accessibilityIdentifier("back")
                Button(action: { state.active?.webView.goForward() }) { Image(systemName: "chevron.right") }
                    .accessibilityIdentifier("forward")
                Button(action: { state.active?.webView.reload() }) { Image(systemName: "arrow.clockwise") }
                    .accessibilityIdentifier("reload")
                TextField("", text: $state.address, prompt: Text("Search or HTTPS address").foregroundColor(Color(white: 0.70)))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.system(size: 12))
                    .foregroundStyle(.white)
                    .padding(.vertical, 5)
                    .padding(.horizontal, 8)
                    .background(Color.black.opacity(0.30))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit { state.navigate(state.address); focused = false }
                    .accessibilityIdentifier("address")
                Button(action: { state.navigate(state.address); focused = false }) { Image(systemName: "arrow.right") }
                    .accessibilityIdentifier("go")
                Button(action: { state.switchPrivacy() }) {
                    Image(systemName: state.active?.isPrivate == true ? "eye.slash.fill" : "eye")
                }
                .accessibilityLabel("Switch current tab private or normal")
                .accessibilityIdentifier("privacy")
            }
            .font(.system(size: 14))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .frame(height: 38)
            Group {
                if let tab = state.active {
                    SecureWebView(state: state, tab: tab)
                        .id(tab.id)
                } else {
                    Color.black
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(red: 0.07, green: 0.10, blue: 0.17))
        .alert("Minternet", isPresented: Binding(
            get: { state.message != nil },
            set: { if !$0 { state.message = nil } }
        )) {
            Button("OK") { state.message = nil }
        } message: {
            Text(state.message ?? "")
        }
    }
}

@main
struct MinternetApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
