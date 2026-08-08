import AppKit

// AppKit has no `@main` synthesis for a plain NSApplicationDelegate the way SwiftUI
// does, so the entry point is spelled out. This file is top-level code, which is why
// the macOS app module is the one target built without `-parse-as-library`.
let delegate = MacAppDelegate()
let app = NSApplication.shared
app.delegate = delegate
app.run()
