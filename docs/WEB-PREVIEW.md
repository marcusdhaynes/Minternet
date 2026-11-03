# Web preview and native desktop browser

The GitHub Pages site is a web-based companion. It displays real HTTPS sites inside an iframe *only when the site allows embedding*. If the destination rejects embedding, use **Open Website** to visit it in your browser. Hosting a static website cannot bypass frame-ancestors / X-Frame-Options, provide real private sessions, or install native extensions.

**The Electron desktop app** is a separate native browser prototype. The GitHub Actions workflow now creates unsigned Windows/macOS/Linux artifacts on source updates. Download the appropriate artifact from a successful workflow run's Artifacts section and install/extract it. Those builds are unsigned and not independently audited. Tor and full Firefox/Chrome extension support are still absent.