// swift-tools-version:5.9
//
// A test harness for the widget's shared logic — NOT a dependency of the app.
//
// ZoneRowResolver decides which rows the home-screen widget shows, in what
// order, and what each one says relative to the others. It is a pure function
// of its arguments, which is what makes it testable at all, and its rules are
// duplicated in Android's GeoTimeWidgetProvider — a duplication the resolver's
// own comment justifies with "one test does not [drift]". This is that test.
//
// The sources are SYMLINKED rather than copied, so there is exactly one copy of
// each file and no way for the tested code to diverge from the shipped code.
// The Xcode project still owns them; this package only borrows them.
//
//   cd ios/SharedKit && swift test
//
import PackageDescription

let package = Package(
    name: "GeoTimeShared",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "GeoTimeShared"),
        .testTarget(name: "GeoTimeSharedTests", dependencies: ["GeoTimeShared"]),
    ]
)
