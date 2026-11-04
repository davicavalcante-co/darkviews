// Recorta o objeto principal de uma foto (Vision do macOS, "Levantar objeto") e grava a máscara em PNG cinza.
// Uso: subject-mask <entrada> <saida.png>   · sai com código 2 se não achar objeto.
import Foundation
import Vision
import CoreImage

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write("uso: subject-mask entrada saida.png\n".data(using: .utf8)!); exit(1) }
let url = URL(fileURLWithPath: args[1])
let handler = VNImageRequestHandler(url: url)
let request = VNGenerateForegroundInstanceMaskRequest()
do {
  try handler.perform([request])
  guard let result = request.results?.first, !result.allInstances.isEmpty else { exit(2) }
  let buffer = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
  let image = CIImage(cvPixelBuffer: buffer)
  let ctx = CIContext()
  try ctx.writePNGRepresentation(of: image, to: URL(fileURLWithPath: args[2]), format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())
} catch {
  FileHandle.standardError.write("\(error)\n".data(using: .utf8)!); exit(1)
}
