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
        var webView: WKWebView?
        var suspended = false
        var checking = false
        var inactiveSince: Date?
        @MainActor static func makeWebView(isPrivate: Bool) -> WKWebView {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = isPrivate ? .nonPersistent() : .default()
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.allowsBackForwardNavigationGestures = true
            view.scrollView.contentInsetAdjustmentBehavior = .never
            return view
        }
        @MainActor init(isPrivate: Bool) {
            self.isPrivate = isPrivate
            self.webView = Tab.makeWebView(isPrivate: isPrivate)
        }
    }

    @Published var tabs: [Tab] = []
    @Published var selectedId: UUID?
    @Published var address: String = ""
    @Published var message: String?
    @Published var autoUnloadMinutes: Int = UserDefaults.standard.object(forKey: "autoUnloadMinutes") as? Int ?? 1 {
        didSet { UserDefaults.standard.set(autoUnloadMinutes, forKey: "autoUnloadMinutes") }
    }
    @Published var tabLimit: Int = max(0, UserDefaults.standard.object(forKey: "tabLimit") as? Int ?? 0) {
        didSet { UserDefaults.standard.set(tabLimit, forKey: "tabLimit") }
    }
    init() { newTab() }

    var active: Tab? { tabs.first(where: { $0.id == selectedId }) }

    func newTab(privateMode: Bool = false, load: URL? = nil) {
        guard tabLimit == 0 || tabs.count < tabLimit else {
            message = "Tab limit reached (\(tabLimit)). Set Tab Limit to 0 for unlimited."
            return
        }
        if let former=active { former.inactiveSince = Date() }
        let tab = Tab(isPrivate: privateMode)
        tabs.append(tab)
        selectedId = tab.id
        address = load?.absoluteString ?? ""
        tab.url = load
        if let load { tab.webView?.load(URLRequest(url: load)) }
    }

    func select(_ id: UUID) {
        if let former=active, former.id != id { former.inactiveSince = Date() }
        selectedId = id
        let tab = active
        tab?.inactiveSince = nil
        if let tab, tab.suspended || tab.webView == nil {
            tab.webView = Tab.makeWebView(isPrivate: tab.isPrivate)
            tab.suspended = false
            if let destination=tab.url, destination.scheme == "https" {
                tab.webView?.load(URLRequest(url: destination))
            }
        }
        address = tab?.webView?.url?.absoluteString ?? tab?.url?.absoluteString ?? ""
        objectWillChange.send()
    }

    func close(_ id: UUID) {
        guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs[index].webView?.stopLoading()
        tabs.remove(at: index)
        if tabs.isEmpty { newTab(); return }
        if selectedId == id { select(tabs[min(index, tabs.count - 1)].id) }
    }

    func switchPrivacy() {
        guard let tab = active,
              let index = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        let destination = tab.webView?.url ?? tab.url
        tab.webView?.stopLoading()
        let replacement = Tab(isPrivate: !tab.isPrivate)
        tabs[index] = replacement
        selectedId = replacement.id
        if let destination, destination.scheme == "https" {
            replacement.webView?.load(URLRequest(url: destination))
            address = destination.absoluteString
        } else {
            address = ""
        }
        // Switching normal -> private NEVER erases data already saved by normal mode.
    }

    func reloadActive() {
        guard let tab = active else { return }
        if tab.webView == nil || tab.suspended {
            // Selecting an unloaded tab recreates its renderer and loads
            // the last real URL; reload must never silently do nothing.
            select(tab.id)
        } else {
            tab.webView?.reload()
        }
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
        if tab.webView == nil { select(tab.id) }
        tab.webView?.load(URLRequest(url: url))
        address = url.absoluteString
    }

    private static let safeToUnload = """
    (()=>{try{
      if(document.readyState!=='complete'||document.hasFocus()||window.onbeforeunload!==null)return false;
      if(document.pictureInPictureElement||navigator.mediaSession?.playbackState==='playing')return false;
      if(document.querySelector('iframe,canvas,[aria-busy="true"],[role="progressbar"],progress,.spinner,.loading'))return false;
      if([...document.querySelectorAll('audio,video')].some(m=>!m.paused||m.seeking||m.networkState===m.NETWORK_LOADING))return false;
      if([...document.querySelectorAll('input,textarea,select')].some(e=>{
        if(['hidden','submit','button','reset'].includes(e.type))return false;
        if(e.type==='checkbox'||e.type==='radio')return e.checked!==e.defaultChecked;
        if(e.type==='file')return e.files?.length>0;
        if(e.tagName==='SELECT')return [...e.options].some(o=>o.selected!==o.defaultSelected);
        return !!e.value;
      }))return false;
      if([...document.querySelectorAll('[contenteditable="true"],[role="textbox"]')].some(e=>e.textContent?.trim()))return false;
      const r=performance.getEntriesByType('resource');
      if(r.length&&performance.now()-(r[r.length-1].responseEnd||r[r.length-1].startTime)<15000)return false;
      return true;
    }catch(e){return false}})()
    """

    func unload(_ tab: Tab) {
        guard tab.id != selectedId, tab.webView != nil else { return }
        tab.webView?.stopLoading()
        tab.webView?.navigationDelegate = nil
        tab.webView?.uiDelegate = nil
        tab.webView?.removeFromSuperview()
        tab.webView = nil
        tab.suspended = true
        tab.checking = false
        objectWillChange.send()
    }

    func manuallyUnload(_ id: UUID) {
        guard let tab=tabs.first(where: { $0.id == id }) else { return }
        if selectedId == id {
            if let other=tabs.first(where: { $0.id != id }) { select(other.id) }
            else { newTab() }
        }
        unload(tab)
    }

    func checkIdleTabs() {
        guard autoUnloadMinutes > 0 else { return }
        for tab in tabs {
            guard tab.id != selectedId, !tab.isPrivate, !tab.suspended, !tab.checking,
                  let since=tab.inactiveSince,
                  Date().timeIntervalSince(since)>=Double(autoUnloadMinutes*60),
                  let view=tab.webView, !view.isLoading, tab.url?.scheme == "https" else { continue }
            tab.checking = true
            view.evaluateJavaScript(Self.safeToUnload) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    tab.checking = false
                    if error == nil, let safe=result as? Bool, safe,
                       tab.id != self.selectedId, tab.webView === view, !view.isLoading,
                       let since=tab.inactiveSince,
                       Date().timeIntervalSince(since)>=Double(self.autoUnloadMinutes*60) {
                        self.unload(tab)
                    }
                }
            }
        }
    }

    func update(_ webView: WKWebView) {
        guard let tab = active, tab.webView === webView else { return }
        tab.url = webView.url ?? tab.url
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
        let view = tab.webView ?? WKWebView(frame: .zero)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

// Every tab has a visible site identity, including websites such as ChatGPT
// that do not provide a conventional /favicon.ico. Prefer PNG icons so
// WKWebView/SwiftUI can render them reliably on iOS.
struct SiteFavicon: View {
    let url: URL?
    private var hostname: String { (url?.host ?? "").lowercased() }
    private var chatGPT: Bool {
        hostname == "chatgpt.com" || hostname.hasSuffix(".chatgpt.com")
    }
    private var glyph: String {
        if chatGPT { return "✳" }
        return hostname.first.map { String($0).uppercased() } ?? "◆"
    }
    private func candidate(_ path: String) -> URL? {
        guard let url, url.scheme == "https" else { return nil }
        return URL(string: path, relativeTo: url)?.absoluteURL
    }
    private var fallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: chatGPT ? 8 : 4)
                .fill(chatGPT ? Color(red: 0.063, green: 0.639, blue: 0.498) : Color.indigo)
            Text(glyph).font(.system(size: chatGPT ? 13 : 10, weight: .heavy))
                .foregroundColor(.white)
        }.frame(width: 16, height: 16)
    }
    var body: some View {
        AsyncImage(url: candidate("/favicon-32x32.png")) { phase in
            if let image = phase.image {
                image.resizable().scaledToFit()
            } else if phase.error != nil {
                AsyncImage(url: candidate("/apple-touch-icon.png")) { secondary in
                    if let image = secondary.image {
                        image.resizable().scaledToFit()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }.frame(width: 16, height: 16)
    }
}

struct ContentView: View {
    @StateObject private var state = BrowserState()
    @FocusState private var focused: Bool
    @State private var showTabLimitEditor = false
    @State private var tabLimitDraft = "0"

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 3) {
                    Image("Brand")
                        .resizable().scaledToFit().frame(width: 24, height: 24)
                        .accessibilityLabel("Minternet")
                    ForEach(state.tabs) { tab in
                        HStack(spacing: 2) {
                            Button(action: { state.select(tab.id) }) {
                                ZStack(alignment: .bottomTrailing) {
                                    SiteFavicon(url: tab.url)
                                    if tab.isPrivate {
                                        Image(systemName: "eye.slash.fill")
                                            .font(.system(size: 7)).foregroundStyle(.purple)
                                    }
                                }
                            }
                            .accessibilityIdentifier("tab-\(tab.id)")
                            .accessibilityLabel(tab.title)
                            .help(tab.suspended ? "Unloaded · "+tab.title : tab.title)
                            Button("×") { state.close(tab.id) }
                                .accessibilityLabel("Close \(tab.title)")
                                .font(.system(size: 13))
                        }
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(height: 25)
                        .background(tab.suspended ? Color.gray.opacity(0.28) : tab.id == state.selectedId ? Color.indigo.opacity(0.55) : Color.white.opacity(0.10))
                        .saturation(tab.suspended ? 0.15 : 1)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .contextMenu {
                            Button("Unload Tab") { state.manuallyUnload(tab.id) }
                            Button("Close Tab", role: .destructive) { state.close(tab.id) }
                        }
                    }
                    Button(action: { state.newTab() }) {
                        Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                    }.accessibilityIdentifier("new-tab")
                }
                .padding(.horizontal, 5)
            }
            .frame(height: 30)
            HStack(spacing: 7) {
                Button(action: { state.active?.webView?.goBack() }) { Image(systemName: "chevron.left") }
                    .accessibilityIdentifier("back")
                Button(action: { state.active?.webView?.goForward() }) { Image(systemName: "chevron.right") }
                    .accessibilityIdentifier("forward")
                Button(action: { state.reloadActive() }) { Image(systemName: "arrow.clockwise") }
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
                Menu {
                    Button("Tab Limit (0 = Unlimited)") {
                        tabLimitDraft = String(state.tabLimit)
                        showTabLimitEditor = true
                    }
                    Picker("Unload Inactive Tabs", selection: $state.autoUnloadMinutes) {
                        Text("Never").tag(0)
                        Text("1 minute").tag(1)
                        Text("2 minutes").tag(2)
                        Text("5 minutes").tag(5)
                        Text("10 minutes").tag(10)
                        Text("15 minutes").tag(15)
                        Text("30 minutes").tag(30)
                        Text("1 hour").tag(60)
                        Text("2 hours").tag(120)
                    }
                } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Browser Settings")
                .alert("Tab Limit", isPresented: $showTabLimitEditor) {
                    TextField("0 = Unlimited", text: $tabLimitDraft)
                        .keyboardType(.numberPad)
                    Button("Save") {
                        if let limit = Int(tabLimitDraft), (0...1000000).contains(limit) {
                            state.tabLimit = limit
                        } else {
                            state.message = "Enter a whole number from 0 to 1000000."
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("0 = Unlimited. Reducing the limit will not close existing tabs.")
                }
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
        .onReceive(Timer.publish(every: 10, on: .main, in: .common).autoconnect()) { _ in
            state.checkIdleTabs()
        }
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
