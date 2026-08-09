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

func focusedWindow(_ appElement: AXUIElement) throws -> AXUIElement {
    guard let window = attribute(appElement, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() else {
        throw HelperError.message("Kein fokussiertes Outlook-Fenster gefunden.")
    }
    return unsafeBitCast(window, to: AXUIElement.self)
}

func closeFocusedWindow(_ appElement: AXUIElement) throws {
    let window = try focusedWindow(appElement)
    guard let button = attribute(window, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID() else {
        throw HelperError.message("Das fokussierte Outlook-Fenster besitzt keinen nutzbaren Schließen-Button.")
    }
    let closeButton = unsafeBitCast(button, to: AXUIElement.self)
    let result = AXUIElementPerformAction(closeButton, kAXPressAction as CFString)
    guard result == .success else { throw HelperError.message("Outlook-Fenster konnte nicht geschlossen werden: AX-Fehler \(result.rawValue).") }
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

func keyboardEvent(_ virtualKey: CGKeyCode, flags: CGEventFlags = []) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: virtualKey, keyDown: false) else {
        throw HelperError.message("Tastaturereignis konnte nicht erstellt werden.")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(70_000)
    up.post(tap: .cghidEventTap)
}

func typeText(_ text: String) throws {
    for scalar in text.unicodeScalars {
        let characters = Array(String(scalar).utf16)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw HelperError.message("Texteingabe konnte nicht erstellt werden.")
        }
        down.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
        up.keyboardSetUnicodeString(stringLength: characters.count, unicodeString: characters)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
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

func pasteText(_ text: String, into element: AXUIElement) throws {
    let pasteboard = NSPasteboard.general
    let previous = snapshotPasteboard(pasteboard)
    pasteboard.clearContents()
    guard pasteboard.setString(text, forType: .string) else {
        restorePasteboard(pasteboard, snapshot: previous)
        throw HelperError.message("Text konnte nicht in die Zwischenablage gelegt werden.")
    }
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    try click(element)
    usleep(120_000)
    try commandShortcut(0) // Befehl+A
    try commandShortcut(9) // Befehl+V
    usleep(250_000)
    restorePasteboard(pasteboard, snapshot: previous)
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let command = arguments.first ?? "doctor"
    let (app, appElement) = try outlookApplication()

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

    if command == "activate" {
        app.activate(options: [.activateIgnoringOtherApps])
        usleep(250_000)
        try writeJSON(["activated": true, "focusedWindowTitle": focusedWindowTitle(appElement)])
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

    if command == "set-value-and-confirm" {
        guard arguments.count >= 4 else { throw HelperError.message("set-value-and-confirm benötigt AX-Rolle, exakte Beschriftung und Wert.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        let result = AXUIElementSetAttributeValue(found[0].element, kAXValueAttribute as CFString, arguments[3] as CFTypeRef)
        guard result == .success else { throw HelperError.message("Wert konnte nicht gesetzt werden: AX-Fehler \(result.rawValue).") }
        let focusResult = AXUIElementSetAttributeValue(found[0].element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if focusResult != .success { try click(found[0].element) }
        usleep(120_000)
        try keyboardEvent(36) // Eingabetaste
        usleep(300_000)
        try writeJSON(["updated": true, "confirmed": true, "element": dictionary(found[0]), "valueLength": arguments[3].count])
        exit(0)
    }

    if command == "set-value-shallowest-and-confirm" {
        guard arguments.count >= 4 else { throw HelperError.message("set-value-shallowest-and-confirm benötigt AX-Rolle, exakte Beschriftung und Wert.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }.sorted { $0.path.count < $1.path.count }
        guard let selected = found.first else { throw HelperError.message("Bedienelement wurde nicht gefunden.") }
        let result = AXUIElementSetAttributeValue(selected.element, kAXValueAttribute as CFString, arguments[3] as CFTypeRef)
        guard result == .success else { throw HelperError.message("Wert konnte nicht gesetzt werden: AX-Fehler \(result.rawValue).") }
        _ = AXUIElementSetAttributeValue(selected.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        try click(selected.element)
        usleep(120_000)
        if AXUIElementPerformAction(selected.element, kAXConfirmAction as CFString) != .success {
            try keyboardEvent(36) // Eingabetaste
        }
        usleep(500_000)
        try writeJSON(["updated": true, "confirmed": true, "matchCount": found.count, "element": dictionary(selected), "valueLength": arguments[3].count])
        exit(0)
    }

    if command == "replace-text-shallowest-and-confirm" {
        guard arguments.count >= 4 else { throw HelperError.message("replace-text-shallowest-and-confirm benötigt AX-Rolle, exakte Beschriftung und Wert.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }.sorted { $0.path.count < $1.path.count }
        guard let selected = found.first else { throw HelperError.message("Bedienelement wurde nicht gefunden.") }
        let focusResult = AXUIElementSetAttributeValue(selected.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if focusResult != .success { try click(selected.element) }
        usleep(100_000)
        try commandShortcut(0) // Befehl+A
        try typeText(arguments[3])
        usleep(150_000)
        try keyboardEvent(36) // Eingabetaste
        usleep(500_000)
        try writeJSON(["updated": true, "confirmed": true, "matchCount": found.count, "element": dictionary(selected), "valueLength": arguments[3].count])
        exit(0)
    }

    if command == "replace-text-and-confirm" {
        guard arguments.count >= 4 else { throw HelperError.message("replace-text-and-confirm benötigt AX-Rolle, exakte Beschriftung und Wert.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        _ = AXUIElementSetAttributeValue(found[0].element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        try click(found[0].element)
        usleep(100_000)
        try commandShortcut(0) // Befehl+A
        try typeText(arguments[3])
        usleep(150_000)
        try keyboardEvent(36) // Eingabetaste
        usleep(250_000)
        try writeJSON(["updated": true, "confirmed": true, "element": dictionary(found[0]), "valueLength": arguments[3].count])
        exit(0)
    }

    if command == "save" {
        try commandShortcut(1) // Befehl+S
        try writeJSON(["saved": true, "focusedWindowTitle": focusedWindowTitle(appElement)])
        exit(0)
    }

    if command == "save-and-close" {
        let windowCountBefore = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
        try commandShortcut(1) // Befehl+S
        usleep(500_000)
        try closeFocusedWindow(appElement)
        usleep(500_000)
        let windowCountAfter = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
        guard windowCountAfter < windowCountBefore else { throw HelperError.message("Der gespeicherte Outlook-Entwurf konnte nicht eindeutig geschlossen werden.") }
        try writeJSON(["saved": true, "closed": true, "focusedWindowTitle": focusedWindowTitle(appElement), "windowCountBefore": windowCountBefore, "windowCountAfter": windowCountAfter])
        exit(0)
    }

    if command == "close-window" {
        let windowCountBefore = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
        try closeFocusedWindow(appElement)
        usleep(400_000)
        let windowCountAfter = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
        try writeJSON(["closeRequested": true, "windowCountBefore": windowCountBefore, "windowCountAfter": windowCountAfter, "focusedWindowTitle": focusedWindowTitle(appElement)])
        exit(0)
    }

    if command == "new-message" {
        app.activate(options: [.activateIgnoringOtherApps])
        usleep(200_000)
        try commandShortcut(45) // Befehl+N
        usleep(700_000)
        let composeNodes = collect(focusedRoot(appElement))
        let accountPickers = composeNodes.filter { matches($0, role: "AXPopUpButton", description: "accountPicker") }
        let subjectFields = composeNodes.filter { matches($0, role: "AXTextField", description: "subjectTextField") }
        guard accountPickers.count == 1 && subjectFields.count == 1 else {
            throw HelperError.message("Outlook hat kein eindeutig prüfbares Verfassen-Fenster geöffnet.")
        }
        try writeJSON(["opened": true, "focusedWindowTitle": focusedWindowTitle(appElement)])
        exit(0)
    }

    if command == "select-popup-option" {
        guard arguments.count >= 4 else { throw HelperError.message("select-popup-option benötigt AX-Rolle, exakte Beschriftung und Suchtext.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        try click(found[0].element)
        usleep(250_000)
        let needle = arguments[3].lowercased()
        let popupNodes = collect(appElement, maxDepth: 22, maxNodes: 9000)
        let matchingOptions = popupNodes.filter { node in
            let searchable = "\(node.title) \(node.description) \(safeValue(node.element))".lowercased()
            return searchable.contains(needle) && ["AXMenuItem", "AXRow", "AXCell", "AXStaticText"].contains(node.role)
        }
        let exactAccountCells = matchingOptions.filter {
            $0.role == "AXCell" && $0.description.lowercased().contains("(\(needle))")
        }
        let actionableCells = matchingOptions.filter { $0.role == "AXCell" }
        let options = exactAccountCells.count == 1 ? exactAccountCells : (actionableCells.count == 1 ? actionableCells : matchingOptions)
        guard options.count == 1 else {
            throw HelperError.message("Outlook-Absenderoption ist nicht eindeutig auffindbar: \(options.count) Treffer für \(arguments[3]).")
        }
        var picked = false
        for action in [kAXPickAction as String, kAXPressAction as String] {
            if AXUIElementPerformAction(options[0].element, action as CFString) == .success {
                picked = true
                break
            }
        }
        if !picked { try click(options[0].element) }
        usleep(500_000)
        try writeJSON(["selected": true, "value": safeValue(found[0].element), "option": dictionary(options[0]), "element": dictionary(found[0])])
        exit(0)
    }

    if command == "popup-items" {
        guard arguments.count >= 3 else { throw HelperError.message("popup-items benötigt AX-Rolle und exakte Beschriftung.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        try click(found[0].element)
        usleep(250_000)
        let popupNodes = collect(appElement, maxDepth: 22, maxNodes: 9000)
        let options = popupNodes.filter { ["AXMenuItem", "AXRow", "AXCell", "AXStaticText"].contains($0.role) }
        try writeJSON(["count": options.count, "options": options.map(dictionary)])
        exit(0)
    }

    if command == "shortcut" {
        guard arguments.count >= 2, let key = UInt16(arguments[1]) else { throw HelperError.message("shortcut benötigt einen virtuellen Tastencode.") }
        let modifiers = arguments.count >= 3 ? arguments[2].lowercased() : ""
        var flags: CGEventFlags = []
        if modifiers.contains("command") { flags.insert(.maskCommand) }
        if modifiers.contains("shift") { flags.insert(.maskShift) }
        if modifiers.contains("option") { flags.insert(.maskAlternate) }
        if modifiers.contains("control") { flags.insert(.maskControl) }
        try keyboardEvent(CGKeyCode(key), flags: flags)
        try writeJSON(["pressed": true, "key": key, "modifiers": modifiers])
        exit(0)
    }

    if command == "type-text" {
        guard arguments.count >= 2 else { throw HelperError.message("type-text benötigt Text.") }
        try typeText(arguments[1])
        try writeJSON(["typed": true, "characterCount": arguments[1].count])
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

    if command == "paste-text" {
        guard arguments.count >= 4 else { throw HelperError.message("paste-text benötigt AX-Rolle, exakte Beschriftung und Text.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        app.activate(options: [.activateIgnoringOtherApps])
        usleep(150_000)
        try pasteText(arguments[3], into: found[0].element)
        if AXUIElementPerformAction(found[0].element, kAXConfirmAction as CFString) != .success {
            try keyboardEvent(36) // Eingabetaste
        }
        usleep(250_000)
        try writeJSON(["pasted": true, "characterCount": arguments[3].count, "element": dictionary(found[0])])
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

    if command == "press-shallowest" {
        guard arguments.count >= 3 else { throw HelperError.message("press-shallowest benötigt AX-Rolle und exakte Beschriftung.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }.sorted { $0.path.count < $1.path.count }
        guard let selected = found.first else { throw HelperError.message("Bedienelement wurde nicht gefunden.") }
        let result = AXUIElementPerformAction(selected.element, kAXPressAction as CFString)
        guard result == .success else { throw HelperError.message("Bedienelement konnte nicht ausgelöst werden: AX-Fehler \(result.rawValue).") }
        try writeJSON(["pressed": true, "matchCount": found.count, "element": dictionary(selected)])
        exit(0)
    }

    if command == "delete-draft-search-result" {
        guard arguments.count >= 2 else { throw HelperError.message("delete-draft-search-result benötigt den exakten Betreff.") }
        let expectedSubject = arguments[1]
        let subjectNeedle = "Betreff: \(expectedSubject),"
        let candidates = nodes.filter { node in
            guard node.role == "AXCell", node.description.contains(subjectNeedle), node.description.contains("Ordner: Entwürfe") else { return false }
            var actionValues: CFArray?
            guard AXUIElementCopyActionNames(node.element, &actionValues) == .success,
                  let actions = actionValues as? [String] else { return false }
            return actions.contains { $0.contains("Name:Löschen") }
        }
        guard candidates.count == 1 else {
            throw HelperError.message("Rückgängig-Abbruch: Erwartet wurde genau ein markierter Entwurf mit diesem Betreff, gefunden wurden \(candidates.count).")
        }
        var actionValues: CFArray?
        _ = AXUIElementCopyActionNames(candidates[0].element, &actionValues)
        let actions = actionValues as? [String] ?? []
        guard let deleteAction = actions.first(where: { $0.contains("Name:Löschen") }) else {
            throw HelperError.message("Rückgängig-Abbruch: Der gefundene Entwurf besitzt keine sichere Löschaktion.")
        }
        let result = AXUIElementPerformAction(candidates[0].element, deleteAction as CFString)
        usleep(600_000)
        if result != .success {
            let remaining = collect(focusedRoot(appElement)).filter { $0.role == "AXCell" && $0.description.contains(subjectNeedle) && $0.description.contains("Ordner: Entwürfe") }
            guard remaining.isEmpty else { throw HelperError.message("Der markierte Entwurf konnte nicht in Gelöschte Elemente verschoben werden: AX-Fehler \(result.rawValue).") }
        }
        try writeJSON(["deleted": true, "recoverableFromDeletedItems": true, "subject": expectedSubject, "element": dictionary(candidates[0])])
        exit(0)
    }

    if command == "delete-account-draft" {
        guard arguments.count >= 2 else { throw HelperError.message("delete-account-draft benötigt den exakten Betreff.") }
        let expectedSubject = arguments[1]
        let subjectNeedle = "Betreff: \(expectedSubject),"
        let candidates = nodes.filter { node in
            guard node.role == "AXCell", node.description.contains(subjectNeedle) else { return false }
            var actionValues: CFArray?
            guard AXUIElementCopyActionNames(node.element, &actionValues) == .success,
                  let actions = actionValues as? [String] else { return false }
            return actions.contains { $0.contains("Name:Löschen") }
        }
        guard candidates.count == 1 else {
            throw HelperError.message("Rückgängig-Abbruch: Im ausgewählten Entwürfe-Ordner wurden \(candidates.count) Entwürfe mit dem exakten Betreff gefunden.")
        }
        var actionValues: CFArray?
        _ = AXUIElementCopyActionNames(candidates[0].element, &actionValues)
        let actions = actionValues as? [String] ?? []
        guard let deleteAction = actions.first(where: { $0.contains("Name:Löschen") }) else {
            throw HelperError.message("Rückgängig-Abbruch: Der gefundene Entwurf besitzt keine sichere Löschaktion.")
        }
        let result = AXUIElementPerformAction(candidates[0].element, deleteAction as CFString)
        usleep(600_000)
        if result != .success {
            let remaining = collect(focusedRoot(appElement)).filter { $0.role == "AXCell" && $0.description.contains(subjectNeedle) }
            guard remaining.isEmpty else { throw HelperError.message("Der IVA-Entwurf konnte nicht in Gelöschte Elemente verschoben werden: AX-Fehler \(result.rawValue).") }
        }
        try writeJSON(["deleted": true, "recoverableFromDeletedItems": true, "subject": expectedSubject, "element": dictionary(candidates[0])])
        exit(0)
    }

    if command == "open-account-drafts" {
        guard arguments.count >= 2 else { throw HelperError.message("open-account-drafts benötigt den exakten Kontonamen.") }
        let accountName = arguments[1]
        let accountCells = nodes.filter { $0.role == "AXCell" && $0.description == accountName }
        guard accountCells.count == 1, accountCells[0].path.count >= 2 else {
            throw HelperError.message("Das Outlook-Konto ist in der Ordnerleiste nicht eindeutig sichtbar.")
        }
        let accountPath = accountCells[0].path
        let siblingPrefix = Array(accountPath.dropLast(2))
        let accountIndex = accountPath[accountPath.count - 2]
        let draftCells = nodes.filter { node in
            guard node.role == "AXCell", node.description.hasPrefix("Entwürfe"), node.path.count == accountPath.count else { return false }
            return Array(node.path.dropLast(2)) == siblingPrefix && node.path[node.path.count - 2] > accountIndex
        }.sorted { $0.path[$0.path.count - 2] < $1.path[$1.path.count - 2] }
        guard let draftCell = draftCells.first else {
            throw HelperError.message("Der Entwürfe-Ordner des Outlook-Kontos ist nicht sichtbar.")
        }
        let rowPath = Array(draftCell.path.dropLast())
        let row = nodes.first { $0.role == "AXRow" && $0.path == rowPath }
        if let row {
            let selected = AXUIElementSetAttributeValue(row.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
            if selected != .success { try click(row.element) }
        } else {
            try click(draftCell.element)
        }
        usleep(900_000)
        try writeJSON(["opened": true, "account": accountName, "folder": draftCell.description, "element": dictionary(draftCell)])
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
