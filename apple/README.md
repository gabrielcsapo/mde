# MDEditor for Swift

`MDEditorUI` exposes the same `MarkdownTextView` name on iOS 17+ and macOS 14+.
The view is backed by each platform’s native text system and keeps Markdown as its source.

## Local package

In Xcode choose **File → Add Package Dependencies… → Add Local…**, select this `apple/`
directory, and add the `MDEditorUI` product to the app target.

```swift
import MDEditorUI

let editor = MarkdownTextView()
editor.setMarkdown("# Hello\n\nMarkdown stays **Markdown**.")
```

On iOS, add the view to a UIKit hierarchy. On macOS, use it as an `NSScrollView`
`documentView`. Optional products expose lower-level engine values (`MDECore`), stable
plugin contracts (`MDEPluginKit`), and reference host services (`MDEHost`).

The local package expects `MDECore.xcframework`, generated from the repository root with:

```sh
./scripts/build-rust.sh
```

Remote Swift Package Manager releases additionally require a repository URL, a versioned
XCFramework archive, and its checksum. See the root `RELEASING.md` checklist.
