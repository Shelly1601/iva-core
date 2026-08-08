import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func text(_ element: AXUIElement, _ name: String) -> String {
    return attribute(element, name) as? String ?? ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    return attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func writeJSON(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

guard AXIsProcessTrusted() else {
    writeJSON(["error": "Bedienungshilfe nicht freigegeben."])
    exit(1)
}
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "net.whatsapp.WhatsApp").first else {
    writeJSON(["running": false, "linkedLikely": false])
    exit(0)
}

let appElement = AXUIElementCreateApplication(app.processIdentifier)
let windows = attribute(appElement, kAXWindowsAttribute) as? [AXUIElement] ?? []
var queue: [(AXUIElement, Int)] = windows.map { ($0, 0) }
var cursor = 0
var nodeCount = 0
var textFieldCount = 0
var rowCount = 0
var buttonCount = 0
var hasQrIndicator = false
var hasLoginIndicator = false
var hasChatIndicator = false
let qrNeedles = ["qr-code", "qr code", "qr‑code", "telefonnummer verknüpfen", "gerät verknüpfen"]
let loginNeedles = ["willkommen bei whatsapp", "weiter, um whatsapp", "loslegen"]
let chatNeedles = ["neuer chat", "neue unterhaltung", "chatliste", "chats", "archiviert", "ungelesen"]

while cursor < queue.count && nodeCount < 8000 {
    let (element, depth) = queue[cursor]
    cursor += 1
    nodeCount += 1
    let role = text(element, kAXRoleAttribute)
    if role == "AXTextField" || role == "AXSearchField" { textFieldCount += 1 }
    if role == "AXRow" || role == "AXCell" { rowCount += 1 }
    if role == "AXButton" { buttonCount += 1 }
    let combined = [
        text(element, kAXTitleAttribute),
        text(element, kAXDescriptionAttribute),
        text(element, kAXIdentifierAttribute),
        text(element, kAXValueAttribute),
    ].joined(separator: " ").lowercased()
    if qrNeedles.contains(where: { combined.contains($0) }) { hasQrIndicator = true }
    if loginNeedles.contains(where: { combined.contains($0) }) { hasLoginIndicator = true }
    if chatNeedles.contains(where: { combined.contains($0) }) { hasChatIndicator = true }
    if depth < 22 {
        for child in children(element) { queue.append((child, depth + 1)) }
    }
}

let linkedLikely = !windows.isEmpty && !hasQrIndicator && !hasLoginIndicator && (hasChatIndicator || rowCount > 2 || textFieldCount > 0)
writeJSON([
    "running": true,
    "windowCount": windows.count,
    "nodeCount": nodeCount,
    "textFieldCount": textFieldCount,
    "rowCount": rowCount,
    "buttonCount": buttonCount,
    "hasQrIndicator": hasQrIndicator,
    "hasLoginIndicator": hasLoginIndicator,
    "hasChatIndicator": hasChatIndicator,
    "linkedLikely": linkedLikely,
])
