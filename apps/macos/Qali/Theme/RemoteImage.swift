import AppKit
import SwiftUI

/// Pictures from the web (avatars), decoded once and kept for the session.
/// `AsyncImage` starts over every time a view appears, so a panel that opens
/// again showed initials until the picture came back; this keeps the decoded
/// image in memory, shares one download among everyone waiting for it, and
/// remembers addresses that failed (Google refuses some avatar requests) so
/// they are not asked for again. Downloads go through the shared URL cache, so
/// a relaunch is served from disk when the server allows it.
@MainActor
final class RemoteImageCache {
  static let shared = RemoteImageCache()

  private let images = NSCache<NSURL, NSImage>()
  private var inFlight: [URL: Task<NSImage?, Never>] = [:]
  private var failed: Set<URL> = []

  func cached(_ url: URL) -> NSImage? { images.object(forKey: url as NSURL) }

  func image(for url: URL) async -> NSImage? {
    if let image = cached(url) { return image }
    if failed.contains(url) { return nil }
    if let task = inFlight[url] { return await task.value }
    let task = Task<NSImage?, Never> {
      var request = URLRequest(url: url)
      request.cachePolicy = .returnCacheDataElseLoad
      guard let (data, response) = try? await URLSession.shared.data(for: request),
        (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true
      else { return nil }
      return NSImage(data: data)
    }
    inFlight[url] = task
    let image = await task.value
    inFlight[url] = nil
    if let image {
      images.setObject(image, forKey: url as NSURL)
    } else {
      failed.insert(url)
    }
    return image
  }
}

/// A cached picture filling its frame; draws nothing until (or unless) it
/// arrives, so whatever sits behind it (an initial) shows meanwhile.
struct RemoteImage: View {
  let url: URL
  @State private var image: NSImage?

  init(url: URL) {
    self.url = url
    _image = State(initialValue: RemoteImageCache.shared.cached(url))
  }

  var body: some View {
    ZStack {
      if let image {
        Image(nsImage: image).resizable().scaledToFill()
      }
    }
    .task(id: url) {
      if image == nil { image = await RemoteImageCache.shared.image(for: url) }
    }
  }
}
