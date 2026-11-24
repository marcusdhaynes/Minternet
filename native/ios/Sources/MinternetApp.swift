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
        var copyingLogins = false
        var copiedLogins = false
        @MainActor static func makeWebView(isPrivate: Bool) -> WKWebView {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = isPrivate ? .nonPersistent() : .default()
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.allowsBackForwardNavigationGestures = true
            view.scrollView.contentInsetAdjustmentBehavior = .never
            return view
        }
        @MainActor init(isPrivate: Bool, adoptedView: WKWebView? = nil) {
            self.isPrivate = isPrivate
            self.webView = adoptedView ?? Tab.makeWebView(isPrivate: isPrivate)
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
    @Published var privateLoginSharing: Bool =
        UserDefaults.standard.object(forKey: "privateLoginSharing") as? Bool ?? true {
        didSet { UserDefaults.standard.set(privateLoginSharing, forKey: "privateLoginSharing") }
    }
    init() { newTab() }

    // Transfer regular-profile HTTP/HTTPS cookies, including HttpOnly sign-in
    // cookies, to a non-persistent private data store BEFORE first navigation.
    // No private cookie or browsing data is written to the normal store.
    private func loadInTab(_ tab: Tab, url: URL) {
        tab.url = url
        guard let view = tab.webView else { return }
        guard tab.isPrivate && privateLoginSharing && !tab.copiedLogins else {
            if !tab.copyingLogins { view.load(URLRequest(url: url)) }
            return
        }
        if tab.copyingLogins { return } // the completion loads the latest URL
        tab.copyingLogins = true
        let privateStore = view.configuration.websiteDataStore.httpCookieStore
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { [weak self, weak tab, weak view] cookies in
            guard let self, let tab, let view else { return }
            let group = DispatchGroup()
            for cookie in cookies {
                // Transfer every cookie with its original domain, path,
                // Secure, HttpOnly and SameSite attributes intact.
                group.enter()
                privateStore.setCookie(cookie) { group.leave() }
            }
            group.notify(queue: .main) { [weak self, weak tab, weak view] in
                Task { @MainActor in
                    guard let self, let tab, let view,
                          self.tabs.contains(where: { $0 === tab }),
                          tab.webView === view else { return }
                    tab.copyingLogins = false
                    tab.copiedLogins = true
                    if let destination = tab.url, destination.scheme == "https" {
                        view.load(URLRequest(url: destination))
                    }
                }
            }
        }
    }

    var active: Tab? { tabs.first(where: { $0.id == selectedId }) }

    @discardableResult
    func newTab(privateMode: Bool = false, load: URL? = nil,
                adoptedView: WKWebView? = nil) -> WKWebView? {
        guard tabLimit == 0 || tabs.count < tabLimit else {
            message = "Tab limit reached (\(tabLimit)). Set Tab Limit to 0 for unlimited."
            return nil
        }
        if let former=active { former.inactiveSince = Date() }
        let tab = Tab(isPrivate: privateMode, adoptedView: adoptedView)
        tabs.append(tab)
        selectedId = tab.id
        address = load?.absoluteString ?? ""
        tab.url = load
        if let load { loadInTab(tab, url: load) }
        return tab.webView
    }

    func select(_ id: UUID) {
        if let former=active, former.id != id { former.inactiveSince = Date() }
        selectedId = id
        let tab = active
        tab?.inactiveSince = nil
        if let tab, tab.suspended || tab.webView == nil {
            tab.webView = Tab.makeWebView(isPrivate: tab.isPrivate)
            tab.suspended = false
            tab.copyingLogins = false
            tab.copiedLogins = false
            if let destination=tab.url, destination.scheme == "https" {
                loadInTab(tab, url: destination)
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
            loadInTab(replacement, url: destination)
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
        else { loadInTab(tab, url: url) }
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
            // WebKit requires returning its actual related child WebView
            // to preserve window.opener and about:blank popup behavior.
            if let url = action.request.url,
               url.scheme != "https" && url.absoluteString != "about:blank" {
                return nil // normal scheme restriction, not popup filtering
            }
            return MainActor.assumeIsolated {
                let child = WKWebView(frame: .zero, configuration: configuration)
                child.navigationDelegate = self
                child.uiDelegate = self
                let privateSource = state.tabs.first(where: { $0.webView === webView })?.isPrivate ?? false
                return state.newTab(privateMode: privateSource, adoptedView: child)
            }
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
    @State private var dashboardOpen = false
    private let chromeForeground = Color(red: 174/255, green: 186/255, blue: 212/255)
    private let addressFill = Color(red: 12/255, green: 20/255, blue: 35/255)

    private func chromeIcon(_ systemName: String, width: CGFloat = 23) -> some View {
        Image(systemName: systemName).font(.system(size: 14))
            .frame(width: width, height: 23).contentShape(Rectangle())
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 3) {
                Image("Brand")
                    .resizable().scaledToFit().frame(width: 18, height: 18)
                    .accessibilityLabel("Minternet")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(state.tabs) { tab in
                            HStack(spacing: 2) {
                                Button(action: { dashboardOpen = false; state.select(tab.id) }) {
                                    HStack(spacing: 3) {
                                        if tab.url == nil {
                                            Image("Brand").resizable().scaledToFit()
                                                .frame(width: 12, height: 12)
                                        } else {
                                            SiteFavicon(url: tab.url)
                                                .scaleEffect(0.75).frame(width: 12, height: 12)
                                        }
                                        Text(tab.title).font(.system(size: 10))
                                            .lineLimit(1).truncationMode(.tail)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .accessibilityIdentifier("tab-\(tab.id)")
                                .accessibilityLabel(tab.title)
                                .help(tab.suspended ? "Unloaded · "+tab.title : tab.title)
                                Button("×") { state.close(tab.id) }
                                    .accessibilityLabel("Close \(tab.title)")
                                    .font(.system(size: 14))
                                    .frame(width: 16, height: 16)
                            }
                            .padding(.leading, 5)
                            .frame(width: 71, height: 20)
                            .foregroundStyle(tab.id == state.selectedId ? Color.white : chromeForeground)
                            .background(tab.suspended ? Color.gray.opacity(0.28) :
                                tab.id == state.selectedId ? Color(red: 49/255, green: 58/255, blue: 81/255) : Color.white.opacity(0.035))
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(
                                tab.id == state.selectedId ? Color(red: 80/255, green: 90/255, blue: 118/255) : .clear, lineWidth: 1))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .contextMenu {
                                Button("Unload Tab") { state.manuallyUnload(tab.id) }
                                Button("Close Tab", role: .destructive) { state.close(tab.id) }
                            }
                        }
                    }
                    .frame(height: 22, alignment: .bottom)
                }
                Button(action: { dashboardOpen = false; state.newTab() }) {
                    chromeIcon("plus", width: 20)
                }.accessibilityIdentifier("new-tab")
                Button(action: { dashboardOpen = false; state.switchPrivacy() }) {
                    chromeIcon(state.active?.isPrivate == true ? "eye.slash.fill" : "eye", width: 21)
                        .foregroundStyle(.purple)
                }
                .accessibilityLabel("Switch current tab private or normal")
                .accessibilityIdentifier("privacy")
                Button(action: { dashboardOpen = true }) {
                    chromeIcon("circle.grid.3x3.fill", width: 21)
                }.accessibilityLabel("Open Dashboard")
            }
            .buttonStyle(.plain)
            .foregroundStyle(chromeForeground)
            .padding(.horizontal, 4)
            .frame(height: 22)
            HStack(spacing: 2) {
                Button(action: { dashboardOpen = false; state.active?.webView?.goBack() }) { chromeIcon("arrow.left") }
                    .accessibilityIdentifier("back")
                Button(action: { dashboardOpen = false; state.active?.webView?.goForward() }) { chromeIcon("arrow.right") }
                    .accessibilityIdentifier("forward")
                Button(action: { dashboardOpen = false; state.reloadActive() }) { chromeIcon("arrow.clockwise") }
                    .accessibilityIdentifier("reload")
                TextField("", text: $state.address, prompt: Text("Search or enter address").foregroundColor(Color(red: 130/255, green: 143/255, blue: 169/255)))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.system(size: 11))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .frame(height: 24)
                    .background(addressFill)
                    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(red: 59/255, green: 67/255, blue: 90/255), lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit { dashboardOpen = false; state.navigate(state.address); focused = false }
                    .accessibilityIdentifier("address")
                Button(action: { dashboardOpen = false; state.navigate(state.address); focused = false }) { chromeIcon("arrow.right") }
                    .accessibilityIdentifier("go")
                Menu {
                    Button("Tab Limit (0 = Unlimited)") {
                        tabLimitDraft = String(state.tabLimit)
                        showTabLimitEditor = true
                    }
                    Toggle("Retain Active Logins in Private Tabs", isOn: $state.privateLoginSharing)
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
                } label: { chromeIcon("gearshape", width: 22) }
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
            }
            .buttonStyle(.plain)
            .foregroundStyle(chromeForeground)
            .padding(.horizontal, 3)
            .frame(height: 30)
            ZStack {
                if let tab = state.active {
                    SecureWebView(state: state, tab: tab)
                        .id(tab.id)
                }
                if dashboardOpen || state.active?.url == nil {
                    Canvas { context, size in
                        let color = Color(red: 128/255, green: 145/255, blue: 191/255).opacity(0.4)
                        for x in stride(from: CGFloat.zero, to: size.width, by: 24) {
                            for y in stride(from: CGFloat.zero, to: size.height, by: 24) {
                                context.fill(Path(ellipseIn: CGRect(x: x-1, y: y-1, width: 2, height: 2)), with: .color(color))
                            }
                        }
                    }
                    .background(Color(red: 11/255, green: 17/255, blue: 32/255))
                    .accessibilityLabel("Dashboard")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(LinearGradient(colors: [Color(red: 29/255, green: 35/255, blue: 51/255), Color(red: 17/255, green: 23/255, blue: 40/255)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .onChange(of: state.selectedId) { _ in dashboardOpen = false }
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
