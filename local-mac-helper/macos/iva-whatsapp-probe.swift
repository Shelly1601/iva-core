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

func frame(_ element: AXUIElement) -> [String: Double]? {
    guard let positionValue = attribute(element, kAXPositionAttribute), CFGetTypeID(positionValue) == AXValueGetTypeID(),
          let sizeValue = attribute(element, kAXSizeAttribute), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(positionValue, to: AXValue.self), .cgPoint, &position),
          AXValueGetValue(unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size) else { return nil }
    return ["x": position.x, "y": position.y, "width": size.width, "height": size.height]
}

func actionNames(_ element: AXUIElement) -> [String] {
    var values: CFArray?
    guard AXUIElementCopyActionNames(element, &values) == .success else { return [] }
    return values as? [String] ?? []
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

func activateApplication(_ app: NSRunningApplication) {
    if #available(macOS 14.0, *) {
        app.activate()
    } else {
        app.activate(options: [.activateIgnoringOtherApps])
    }
    usleep(300_000)
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
let commandArguments = Array(CommandLine.arguments.dropFirst())
let dumpRequested = commandArguments.contains("--dump")
let openChatIndex = commandArguments.firstIndex(of: "--open-chat")
let requestedChat = openChatIndex.flatMap { index in
    commandArguments.indices.contains(index + 1) ? commandArguments[index + 1] : nil
}
let pressIdentifierIndex = commandArguments.firstIndex(of: "--press-identifier")
let requestedButtonIdentifier = pressIdentifierIndex.flatMap { index in
    commandArguments.indices.contains(index + 1) ? commandArguments[index + 1] : nil
}
let pressDescriptionIndex = commandArguments.firstIndex(of: "--press-description")
let requestedButtonDescription = pressDescriptionIndex.flatMap { index in
    commandArguments.indices.contains(index + 1) ? commandArguments[index + 1] : nil
}
let scrollMembersIndex = commandArguments.firstIndex(of: "--scroll-members")
let requestedScrollSteps = scrollMembersIndex.flatMap { index in
    commandArguments.indices.contains(index + 1) ? Int32(commandArguments[index + 1]) : nil
}
var cursor = 0
var nodeCount = 0
var textFieldCount = 0
var rowCount = 0
var buttonCount = 0
var hasQrIndicator = false
var hasLoginIndicator = false
var hasChatIndicator = false
var textNodes: [[String: Any]] = []
var chatButtons: [(element: AXUIElement, description: String, identifier: String)] = []
let qrNeedles = ["qr-code", "qr code", "qr‑code", "telefonnummer verknüpfen", "gerät verknüpfen"]
let loginNeedles = ["willkommen bei whatsapp", "weiter, um whatsapp", "loslegen"]
let chatNeedles = ["neuer chat", "neue unterhaltung", "chatliste", "chats", "archiviert", "ungelesen"]

while cursor < queue.count && nodeCount < 8000 {
    let (element, depth) = queue[cursor]
    cursor += 1
    nodeCount += 1
    let role = text(element, kAXRoleAttribute)
    let elementDescription = text(element, kAXDescriptionAttribute)
    if role == "AXTextField" || role == "AXSearchField" { textFieldCount += 1 }
    if role == "AXRow" || role == "AXCell" { rowCount += 1 }
    if role == "AXButton" {
        buttonCount += 1
        chatButtons.append((
            element: element,
            description: elementDescription,
            identifier: text(element, kAXIdentifierAttribute)
        ))
    }
    let combined = [
        text(element, kAXTitleAttribute),
        text(element, kAXDescriptionAttribute),
        text(element, kAXIdentifierAttribute),
        text(element, kAXValueAttribute),
    ].joined(separator: " ").lowercased()
    let includeStructuralNode = ["AXScrollArea", "AXTable", "AXList", "AXOutline"].contains(role)
    if dumpRequested && (!combined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || includeStructuralNode) && textNodes.count < 600 {
        var node: [String: Any] = [
            "role": role,
            "title": text(element, kAXTitleAttribute),
            "description": text(element, kAXDescriptionAttribute),
            "identifier": text(element, kAXIdentifierAttribute),
            "value": text(element, kAXValueAttribute),
            "depth": depth,
            "actions": actionNames(element),
        ]
        if let elementFrame = frame(element) { node["frame"] = elementFrame }
        textNodes.append(node)
    }
    if qrNeedles.contains(where: { combined.contains($0) }) { hasQrIndicator = true }
    if loginNeedles.contains(where: { combined.contains($0) }) { hasLoginIndicator = true }
    if chatNeedles.contains(where: { combined.contains($0) }) { hasChatIndicator = true }
    if depth < 22 {
        for child in children(element) { queue.append((child, depth + 1)) }
    }
}

if let requestedScrollSteps, requestedScrollSteps != 0 {
    let participantButtons = chatButtons.compactMap { button -> (AXUIElement, CGRect)? in
        guard button.identifier.isEmpty,
              !button.description.isEmpty,
              let values = frame(button.element),
              let x = values["x"], let y = values["y"],
              let width = values["width"], let height = values["height"],
              x > 650, y > 330, width > 350, height > 30, height < 100 else { return nil }
        return (button.element, CGRect(x: x, y: y, width: width, height: height))
    }
    guard let target = participantButtons.sorted(by: { $0.1.maxY < $1.1.maxY }).last else {
        writeJSON(["scrolled": false, "error": "Mitgliederliste nicht eindeutig sichtbar."])
        exit(2)
    }
    activateApplication(app)
    if let mainWindow = windows.first { _ = AXUIElementPerformAction(mainWindow, kAXRaiseAction as CFString) }
    let action = requestedScrollSteps < 0 ? "AXScrollDownByPage" : "AXScrollUpByPage"
    let repetitions = min(10, max(1, abs(Int(requestedScrollSteps))))
    for _ in 0..<repetitions {
        let result = AXUIElementPerformAction(target.0, action as CFString)
        guard result == .success else {
            writeJSON(["scrolled": false, "error": "Mitgliederliste konnte nicht geblättert werden.", "axError": result.rawValue])
            exit(3)
        }
        usleep(220_000)
    }
    usleep(500_000)
    writeJSON(["scrolled": true, "steps": requestedScrollSteps, "action": action, "targetDescription": text(target.0, kAXDescriptionAttribute)])
    exit(0)
}

if let requestedButtonDescription, !requestedButtonDescription.isEmpty {
    let needle = requestedButtonDescription.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    let matches = chatButtons.filter { button in
        button.description.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).contains(needle)
    }
    guard matches.count == 1 else {
        writeJSON(["pressed": false, "requestedDescription": requestedButtonDescription, "matchCount": matches.count])
        exit(2)
    }
    activateApplication(app)
    if let mainWindow = windows.first {
        _ = AXUIElementSetAttributeValue(mainWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(mainWindow, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementPerformAction(mainWindow, kAXRaiseAction as CFString)
        usleep(250_000)
    }
    let actionResult = AXUIElementPerformAction(matches[0].element, kAXPressAction as CFString)
    guard actionResult == .success else {
        writeJSON(["pressed": false, "requestedDescription": requestedButtonDescription, "axError": actionResult.rawValue])
        exit(3)
    }
    usleep(800_000)
    writeJSON(["pressed": true, "requestedDescription": requestedButtonDescription, "description": matches[0].description])
    exit(0)
}

if let requestedButtonIdentifier, !requestedButtonIdentifier.isEmpty {
    let matches = chatButtons.filter { $0.identifier == requestedButtonIdentifier }
    guard matches.count == 1 else {
        writeJSON(["pressed": false, "requestedIdentifier": requestedButtonIdentifier, "matchCount": matches.count])
        exit(2)
    }
    activateApplication(app)
    if let mainWindow = windows.first {
        _ = AXUIElementSetAttributeValue(mainWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(mainWindow, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementPerformAction(mainWindow, kAXRaiseAction as CFString)
        usleep(250_000)
    }
    let actionResult = AXUIElementPerformAction(matches[0].element, kAXPressAction as CFString)
    guard actionResult == .success else {
        writeJSON(["pressed": false, "requestedIdentifier": requestedButtonIdentifier, "axError": actionResult.rawValue])
        exit(3)
    }
    usleep(800_000)
    writeJSON(["pressed": true, "requestedIdentifier": requestedButtonIdentifier, "description": matches[0].description])
    exit(0)
}

if let requestedChat, !requestedChat.isEmpty {
    let needle = requestedChat.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    let matches = chatButtons.filter { button in
        button.description.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).hasPrefix(needle)
    }
    guard matches.count == 1 else {
        writeJSON(["opened": false, "requestedChat": requestedChat, "matchCount": matches.count])
        exit(2)
    }
    activateApplication(app)
    if let mainWindow = windows.first {
        _ = AXUIElementSetAttributeValue(mainWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(mainWindow, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementPerformAction(mainWindow, kAXRaiseAction as CFString)
        usleep(250_000)
    }
    let actionResult = AXUIElementPerformAction(matches[0].element, kAXPressAction as CFString)
    guard actionResult == .success else {
        writeJSON(["opened": false, "requestedChat": requestedChat, "axError": actionResult.rawValue])
        exit(3)
    }
    usleep(800_000)
    writeJSON(["opened": true, "requestedChat": requestedChat, "matchedDescription": matches[0].description])
    exit(0)
}

let linkedLikely = !windows.isEmpty && !hasQrIndicator && !hasLoginIndicator && (hasChatIndicator || rowCount > 2 || textFieldCount > 0)
var result: [String: Any] = [
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
]
if dumpRequested { result["textNodes"] = textNodes }
writeJSON(result)
