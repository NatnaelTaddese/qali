import Foundation
import Testing
@testable import Qali

/// The What's New sheet: when it shows, and how it reads the release notes.
@MainActor
struct WhatsNewTests {
  @Test func showsAfterAnUpdate() {
    #expect(WhatsNew.isUpdate(previous: "0.1.6", current: "0.1.7", usedBefore: true))
    // Numeric, not lexical: 0.1.10 follows 0.1.9.
    #expect(WhatsNew.isUpdate(previous: "0.1.9", current: "0.1.10", usedBefore: true))
  }

  @Test func staysQuietOnTheSameVersionOrADowngrade() {
    #expect(!WhatsNew.isUpdate(previous: "0.1.7", current: "0.1.7", usedBefore: true))
    #expect(!WhatsNew.isUpdate(previous: "0.1.8", current: "0.1.7", usedBefore: true))
  }

  @Test func withoutARecordOnlyAUsedCopyCountsAsAnUpdate() {
    // A copy from before the sheet existed has saved its window.
    #expect(WhatsNew.isUpdate(previous: nil, current: "0.1.7", usedBefore: true))
    // A fresh install hasn't.
    #expect(!WhatsNew.isUpdate(previous: nil, current: "0.1.7", usedBefore: false))
  }

  @Test func readsTheBulletsTitlesAndBodies() throws {
    let notes = try #require(ReleaseNotes(version: "0.1.7", markdown: """
      ## What's new in 0.1.7

      - **Guest avatars.** Event cards show who's coming.
      - **Fixes.** Use Weekly works again.
      - A line with no title.
      """))
    #expect(notes.items.map(\.title) == ["Guest avatars", "Fixes", ""])
    #expect(notes.items.map(\.body) == [
      "Event cards show who's coming.", "Use Weekly works again.", "A line with no title.",
    ])
  }

  @Test func notesWithoutBulletsHaveNothingToShow() {
    #expect(ReleaseNotes(version: "0.1.7", markdown: "## What's new in 0.1.7\n\nNothing yet.") == nil)
  }

  @Test func everyBundledReleaseHasNotes() {
    // The app carries its own version's notes, which the sheet reads.
    #expect(ReleaseNotes.bundled(version: WhatsNew.currentVersion) != nil)
  }
}
