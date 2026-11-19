// swift-tools-version: 6.2
import PackageDescription

// The pure calendar logic, ported from packages/domain/src (the TypeScript
// source of truth shared by the web and Expo apps). No UI, no Convex: it runs
// under `swift test` on the Mac without a simulator.
let package = Package(
  name: "QaliDomain",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "QaliDomain", targets: ["QaliDomain"])
  ],
  targets: [
    .target(name: "QaliDomain"),
    .testTarget(
      name: "QaliDomainTests",
      dependencies: ["QaliDomain"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
