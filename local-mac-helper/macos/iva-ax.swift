import AppKit
import ApplicationServices
import Foundation

struct AXNode {
    let element: AXUIElement
    let path: [Int]
    let role: String
    let title: String
    let description: String
    let identifier: String
}

enum HelperError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let text): return text }
    }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}

func textAttribute(_ element: AXUIElement, _ name: String) -> String {
    guard let value = attribute(element, name) else { return "" }
    if let text = value as? String { return text }
    return ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = attribute(element, kAXChildrenAttribute), let items = value as? [AXUIElement] else { return [] }
    return items
}

func collect(_ root: AXUIElement, maxDepth: Int = 18, maxNodes: Int = 6000) -> [AXNode] {
    var output: [AXNode] = []
    var queue: [(AXUIElement, [Int], Int)] = [(root, [], 0)]
    var cursor = 0
    while cursor < queue.count && output.count < maxNodes {
        let (element, path, depth) = queue[cursor]
        cursor += 1
        output.append(AXNode(
            element: element,
            path: path,
            role: textAttribute(element, kAXRoleAttribute),
            title: textAttribute(element, kAXTitleAttribute),
            description: textAttribute(element, kAXDescriptionAttribute),
            identifier: textAttribute(element, kAXIdentifierAttribute)
        ))
        if depth >= maxDepth { continue }
        for (index, child) in children(element).enumerated() {
            queue.append((child, path + [index], depth + 1))
        }
    }
    return output
}

func outlookApplication() throws -> (NSRunningApplication, AXUIElement) {
    guard AXIsProcessTrusted() else {
        throw HelperError.message("macOS-Bedienungshilfe ist für den aufrufenden Helper nicht freigegeben.")
    }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.microsoft.Outlook").first else {
        throw HelperError.message("Microsoft Outlook läuft nicht.")
    }
    return (app, AXUIElementCreateApplication(app.processIdentifier))
}

func focusedRoot(_ appElement: AXUIElement) -> AXUIElement {
    if let window = attribute(appElement, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
        return unsafeBitCast(window, to: AXUIElement.self)
    }
    return appElement
}

func dictionary(_ node: AXNode) -> [String: Any] {
    var actionValues: CFArray?
    let actionResult = AXUIElementCopyActionNames(node.element, &actionValues)
    let actions = actionResult == .success ? (actionValues as? [String] ?? []) : []
    let enabledValue = attribute(node.element, kAXEnabledAttribute) as? Bool ?? true
    return [
        "path": node.path,
        "role": node.role,
        "title": node.title,
        "description": node.description,
        "identifier": node.identifier,
        "enabled": enabledValue,
        "actions": actions,
    ] as [String: Any]
}

func safeValue(_ element: AXUIElement) -> String {
    guard let value = attribute(element, kAXValueAttribute) else { return "" }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return ""
}

func focusedWindowTitle(_ appElement: AXUIElement) -> String {
    guard let window = attribute(appElement, kAXFocusedWindowAttribute),
          CFGetTypeID(window) == AXUIElementGetTypeID() else { return "" }
    return textAttribute(unsafeBitCast(window, to: AXUIElement.self), kAXTitleAttribute)
}

func writeJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func matches(_ node: AXNode, role: String, description: String) -> Bool {
    guard node.role == role else { return false }
    return description.isEmpty || node.description == description || node.title == description || node.identifier == description
}

func centerPoint(_ element: AXUIElement) throws -> CGPoint {
    guard let positionValue = attribute(element, kAXPositionAttribute), CFGetTypeID(positionValue) == AXValueGetTypeID(),
          let sizeValue = attribute(element, kAXSizeAttribute), CFGetTypeID(sizeValue) == AXValueGetTypeID() else {
        throw HelperError.message("Bedienelement hat keine nutzbare Bildschirmposition.")
    }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(positionValue, to: AXValue.self), .cgPoint, &position),
          AXValueGetValue(unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size) else {
        throw HelperError.message("Position oder Größe des Bedienelements konnte nicht gelesen werden.")
    }
    return CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)
}

func click(_ element: AXUIElement) throws {
    let point = try centerPoint(element)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        throw HelperError.message("Mausereignis konnte nicht erstellt werden.")
    }
    down.post(tap: .cghidEventTap)
    usleep(70_000)
    up.post(tap: .cghidEventTap)
}

func commandShortcut(_ virtualKey: CGKeyCode) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) else {
        throw HelperError.message("Tastaturereignis konnte nicht erstellt werden.")
    }
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    usleep(70_000)
    up.post(tap: .cghidEventTap)
}

func snapshotPasteboard(_ pasteboard: NSPasteboard) -> [[String: Data]] {
    return (pasteboard.pasteboardItems ?? []).map { item in
        var stored: [String: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) { stored[type.rawValue] = data }
        }
        return stored
    }
}

func restorePasteboard(_ pasteboard: NSPasteboard, snapshot: [[String: Data]]) {
    pasteboard.clearContents()
    let items = snapshot.map { stored -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (rawType, data) in stored {
            item.setData(data, forType: NSPasteboard.PasteboardType(rawType))
        }
        return item
    }
    if !items.isEmpty { pasteboard.writeObjects(items) }
}

func pasteHTMLFile(_ filePath: String, into element: AXUIElement) throws -> Int {
    let fileURL = URL(fileURLWithPath: filePath)
    let htmlData = try Data(contentsOf: fileURL)
    guard let attributed = try? NSAttributedString(
        data: htmlData,
        options: [
            .documentType: NSAttributedString.DocumentType.html,
            .characterEncoding: String.Encoding.utf8.rawValue,
            .baseURL: fileURL.deletingLastPathComponent(),
        ],
        documentAttributes: nil
    ) else {
        throw HelperError.message("HTML konnte nicht als formatierter Mailtext gelesen werden.")
    }
    let rtfData = try attributed.data(
        from: NSRange(location: 0, length: attributed.length),
        documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]
    )
    let pasteboard = NSPasteboard.general
    let previous = snapshotPasteboard(pasteboard)
    pasteboard.clearContents()
    let item = NSPasteboardItem()
    item.setData(htmlData, forType: .html)
    item.setData(rtfData, forType: .rtf)
    item.setString(attributed.string, forType: .string)
    guard pasteboard.writeObjects([item]) else {
        restorePasteboard(pasteboard, snapshot: previous)
        throw HelperError.message("Formatierter Mailtext konnte nicht in die Zwischenablage gelegt werden.")
    }

    let focusResult = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if focusResult != .success { try click(element) }
    usleep(100_000)
    try commandShortcut(0) // Befehl+A
    usleep(100_000)
    try commandShortcut(9) // Befehl+V
    usleep(700_000)
    restorePasteboard(pasteboard, snapshot: previous)
    return attributed.length
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let command = arguments.first ?? "doctor"
    let (_, appElement) = try outlookApplication()

    if command == "doctor" {
        let windowCount = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
        try writeJSON([
            "trusted": true,
            "outlookRunning": true,
            "windowCount": windowCount,
            "focusedWindowTitle": focusedWindowTitle(appElement),
        ])
        exit(0)
    }

    let root = command == "menu-items" ? appElement : focusedRoot(appElement)
    let nodes = collect(root)

    if command == "find" {
        guard arguments.count >= 2 else { throw HelperError.message("find benötigt mindestens eine AX-Rolle.") }
        let role = arguments[1]
        let description = arguments.count >= 3 ? arguments[2] : ""
        let found = nodes.filter { matches($0, role: role, description: description) }
        try writeJSON(["count": found.count, "matches": found.map(dictionary)])
        exit(found.isEmpty ? 2 : 0)
    }

    if command == "value" {
        guard arguments.count >= 3 else { throw HelperError.message("value benötigt AX-Rolle und exakte Beschriftung.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        try writeJSON([
            "value": safeValue(found[0].element),
            "element": dictionary(found[0]),
            "focusedWindowTitle": focusedWindowTitle(appElement),
        ])
        exit(0)
    }

    if command == "set-value" {
        guard arguments.count >= 4 else { throw HelperError.message("set-value benötigt AX-Rolle, exakte Beschriftung und Wert.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        let result = AXUIElementSetAttributeValue(found[0].element, kAXValueAttribute as CFString, arguments[3] as CFTypeRef)
        guard result == .success else { throw HelperError.message("Wert konnte nicht gesetzt werden: AX-Fehler \(result.rawValue).") }
        try writeJSON([
            "updated": true,
            "element": dictionary(found[0]),
            "valueLength": arguments[3].count,
        ])
        exit(0)
    }

    if command == "save" {
        try commandShortcut(1) // Befehl+S
        try writeJSON(["saved": true, "focusedWindowTitle": focusedWindowTitle(appElement)])
        exit(0)
    }

    if command == "paste-html-file" {
        guard arguments.count >= 4 else { throw HelperError.message("paste-html-file benötigt AX-Rolle, exakte Beschriftung und Dateipfad.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        let characterCount = try pasteHTMLFile(arguments[3], into: found[0].element)
        try writeJSON([
            "pasted": true,
            "characterCount": characterCount,
            "element": dictionary(found[0]),
        ])
        exit(0)
    }

    if command == "press" {
        guard arguments.count >= 3 else { throw HelperError.message("press benötigt AX-Rolle und exakte Beschriftung.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        let result = AXUIElementPerformAction(found[0].element, kAXPressAction as CFString)
        guard result == .success else { throw HelperError.message("Bedienelement konnte nicht ausgelöst werden: AX-Fehler \(result.rawValue).") }
        try writeJSON(["pressed": true, "element": dictionary(found[0])])
        exit(0)
    }

    if command == "action" {
        guard arguments.count >= 4 else { throw HelperError.message("action benötigt AX-Rolle, exakte Beschriftung und Aktionsnamen.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        let result = AXUIElementPerformAction(found[0].element, arguments[3] as CFString)
        guard result == .success else { throw HelperError.message("Bedienelement konnte nicht ausgelöst werden: AX-Fehler \(result.rawValue).") }
        try writeJSON(["performed": arguments[3], "element": dictionary(found[0])])
        exit(0)
    }

    if command == "click" {
        guard arguments.count >= 3 else { throw HelperError.message("click benötigt AX-Rolle und exakte Beschriftung.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        try click(found[0].element)
        try writeJSON(["clicked": true, "element": dictionary(found[0])])
        exit(0)
    }

    if command == "menu-items" {
        let needle = arguments.count >= 2 ? arguments[1].lowercased() : ""
        let found = nodes.filter { node in
            guard node.role == "AXMenuItem" else { return false }
            if needle.isEmpty { return true }
            return node.title.lowercased().contains(needle) || node.description.lowercased().contains(needle)
        }
        try writeJSON(["count": found.count, "matches": found.map(dictionary)])
        exit(found.isEmpty ? 2 : 0)
    }

    if command == "search" {
        guard arguments.count >= 2 else { throw HelperError.message("search benötigt einen Suchtext.") }
        let needle = arguments[1].lowercased()
        let found = nodes.filter { node in
            node.title.lowercased().contains(needle)
                || node.description.lowercased().contains(needle)
                || node.identifier.lowercased().contains(needle)
        }
        try writeJSON(["count": found.count, "matches": found.map(dictionary)])
        exit(found.isEmpty ? 2 : 0)
    }

    throw HelperError.message("Unbekannter Befehl: \(command)")
} catch {
    let payload = ["error": String(describing: error)]
    try? writeJSON(payload)
    exit(1)
}
