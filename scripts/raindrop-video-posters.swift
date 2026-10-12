import Foundation
import AVFoundation
import AppKit
struct Job: Decodable { let id: String; let input: String; let output: String }
let jobs = try JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var done = 0
var failed: [String] = []
for job in jobs {
  do {
    let asset = AVURLAsset(url: URL(fileURLWithPath: job.input))
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1024, height: 1024)
    let image = try generator.copyCGImage(at: CMTime(value: 0, timescale: 1), actualTime: nil)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { throw NSError(domain: "poster", code: 1) }
    try jpg.write(to: URL(fileURLWithPath: job.output), options: .atomic)
    done += 1
  } catch { failed.append(job.id) }
  if (done + failed.count) % 25 == 0 { print("Posters processed: \(done + failed.count)/\(jobs.count)") }
}
let result: [String: Any] = ["created": done, "failed": failed]
let output = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted])
try output.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print("Posters created: \(done); failed: \(failed.count)")
