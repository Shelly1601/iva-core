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

func descendant(_ root: AXUIElement, path: [Int]) -> AXUIElement? {
    var current = root
    for index in path {
        let items = children(current)
        guard items.indices.contains(index) else { return nil }
        current = items[index]
    }
    return current
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

func activateApplication(_ app: NSRunningApplication) {
    if #available(macOS 14.0, *) {
        app.activate()
    } else {
        activateApplication(app)
    }
    usleep(300_000)
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
    var result: [String: Any] = [
        "path": node.path,
        "role": node.role,
        "title": node.title,
        "description": node.description,
        "identifier": node.identifier,
        "enabled": enabledValue,
        "actions": actions,
    ]
    if let frame = elementFrame(node.element) {
        result["frame"] = ["x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height]
    }
    return result
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

func normalizedAXText(_ value: String) -> String {
    return value.replacingOccurrences(of: "\u{00a0}", with: " ")
        .replacingOccurrences(of: "\n", with: " ")
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func matchesSidebarLabel(_ node: AXNode, label: String) -> Bool {
    guard node.role == "AXRow" || node.role == "AXCell" else { return false }
    let expected = normalizedAXText(label)
    let values = [node.description, node.title, safeValue(node.element)].map(normalizedAXText)
    return values.contains(expected) || values.contains { value in
        value.hasPrefix(expected + " ") || value.hasPrefix(expected + ";")
    }
}

func sidebarFolder(after account: AXNode, named folderName: String, in nodes: [AXNode]) -> AXNode? {
    guard !account.path.isEmpty else { return nil }
    let depthToDrop = account.role == "AXCell" && account.path.count >= 2 ? 2 : 1
    let prefix = Array(account.path.dropLast(depthToDrop))
    let indexPosition = account.path.count - depthToDrop
    let accountIndex = account.path[indexPosition]
    return nodes.filter { node in
        guard node.role == account.role, node.path.count == account.path.count,
              Array(node.path.dropLast(depthToDrop)) == prefix,
              node.path[indexPosition] > accountIndex else { return false }
        return matchesSidebarLabel(node, label: folderName)
    }.sorted { $0.path[indexPosition] < $1.path[indexPosition] }.first
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

func elementFrame(_ element: AXUIElement) -> CGRect? {
    guard let positionValue = attribute(element, kAXPositionAttribute), CFGetTypeID(positionValue) == AXValueGetTypeID(),
          let sizeValue = attribute(element, kAXSizeAttribute), CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(positionValue, to: AXValue.self), .cgPoint, &position),
          AXValueGetValue(unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: position, size: size)
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

func pathPrefix(_ prefix: [Int], matches path: [Int]) -> Bool {
    guard prefix.count <= path.count else { return false }
    return Array(path.prefix(prefix.count)) == prefix
}

func sixDigitCodes(_ value: String) -> [String] {
    let pattern = "(?<![0-9])([0-9]{3})[\\s-]?([0-9]{3})(?![0-9])"
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return regex.matches(in: value, range: range).compactMap { match in
        guard match.numberOfRanges == 3,
              let first = Range(match.range(at: 1), in: value),
              let second = Range(match.range(at: 2), in: value) else { return nil }
        return String(value[first]) + String(value[second])
    }
}

func enteAuthApplication() throws -> (NSRunningApplication, AXUIElement) {
    guard AXIsProcessTrusted() else {
        throw HelperError.message("macOS-Bedienungshilfe ist für den aufrufenden Helper nicht freigegeben.")
    }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "io.ente.auth").first else {
        throw HelperError.message("Ente Auth läuft nicht.")
    }
    return (app, AXUIElementCreateApplication(app.processIdentifier))
}

func enteNodeText(_ node: AXNode) -> String {
    return normalizedAXText([node.title, node.description, safeValue(node.element)].joined(separator: " ")).lowercased()
}

func findPanasonicEnteCode(_ nodes: [AXNode]) -> (entryFound: Bool, code: String?) {
    let targets = nodes.filter { node in
        let text = enteNodeText(node)
        return text.contains("phvaceu-prod") && text.contains("panasonic")
    }
    guard !targets.isEmpty else { return (false, nil) }
    for target in targets.sorted(by: { $0.path.count > $1.path.count }) {
        for depth in stride(from: target.path.count, through: 0, by: -1) {
            let prefix = Array(target.path.prefix(depth))
            let scope = nodes.filter { pathPrefix(prefix, matches: $0.path) }
            let scopeText = scope.map(enteNodeText).joined(separator: " ")
            if scopeText.contains("lausig") { continue }
            let codes = Set(scope.flatMap { sixDigitCodes([$0.title, $0.description, safeValue($0.element)].joined(separator: " ")) })
            if codes.count == 1 { return (true, codes.first) }
            if codes.count > 1 && depth <= max(0, target.path.count - 3) { break }
        }
    }
    return (true, nil)
}

func focusPanasonicOtpInChrome() throws {
    let source = """
    tell application "Google Chrome"
      activate
      repeat with w in windows
        repeat with tabIndex from 1 to (count of tabs of w)
          set t to tab tabIndex of w
          if (URL of t contains "hvac-key.eu.panasonic.com/u/mfa-otp-challenge") then
            set active tab index of w to tabIndex
            set index of w to 1
            execute t javascript "(() => { const e = document.querySelector('#code, input[name=code], input[autocomplete=one-time-code]'); if (!e) return 'NO_FIELD'; e.focus(); e.select?.(); return 'FOCUSED'; })()"
            return "FOCUSED"
          end if
        end repeat
      end repeat
      return "NO_TAB"
    end tell
    """
    var error: NSDictionary?
    guard let script = NSAppleScript(source: source), script.executeAndReturnError(&error).stringValue == "FOCUSED" else {
        throw HelperError.message("Das echte Panasonic-2FA-Feld ist in Chrome nicht geöffnet.")
    }
    usleep(350_000)
}

func enteAuthStatus() throws -> [String: Any] {
    let (_, appElement) = try enteAuthApplication()
    let match = findPanasonicEnteCode(collect(appElement))
    return [
        "running": true,
        "accessibility": true,
        "exactEntryFound": match.entryFound,
        "currentCodeAvailable": match.code != nil,
        "secretReturned": false,
    ]
}

func typePanasonicCodeFromEnte() throws -> [String: Any] {
    let (app, appElement) = try enteAuthApplication()
    activateApplication(app)
    let match = findPanasonicEnteCode(collect(appElement))
    guard match.entryFound else { throw HelperError.message("Der exakte Ente-Auth-Eintrag phvaceu-prod / Panasonic wurde nicht gefunden.") }
    guard let code = match.code else { throw HelperError.message("Der aktuelle Panasonic-Code konnte im richtigen Ente-Eintrag nicht eindeutig erkannt werden.") }
    try focusPanasonicOtpInChrome()
    try typeText(code)
    try keyboardEvent(36)
    return [
        "typed": true,
        "submitted": true,
        "digits": code.count,
        "entry": "phvaceu-prod / Panasonic",
        "clipboardUsed": false,
        "secretReturned": false,
    ]
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

func xlsxNames(in nodes: [AXNode]) throws -> [String] {
    let regex = try NSRegularExpression(pattern: #"[A-Z0-9ÄÖÜäöüß._-]+\.xlsx"#, options: [.caseInsensitive])
    var names = Set<String>()
    for node in nodes {
        let searchable = "\(node.title) \(node.description) \(safeValue(node.element))"
        let range = NSRange(searchable.startIndex..<searchable.endIndex, in: searchable)
        for match in regex.matches(in: searchable, range: range) {
            if let swiftRange = Range(match.range, in: searchable) {
                names.insert(String(searchable[swiftRange]))
            }
        }
    }
    return Array(names).sorted()
}

func composeRecipientEmails(in nodes: [AXNode]) throws -> [String] {
    let regex = try NSRegularExpression(pattern: "[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", options: [.caseInsensitive])
    var emails = Set<String>()
    for node in nodes {
        let searchable = "\(node.title) \(node.description) \(safeValue(node.element))"
        let range = NSRange(searchable.startIndex..<searchable.endIndex, in: searchable)
        for match in regex.matches(in: searchable, range: range) {
            if let swiftRange = Range(match.range, in: searchable) {
                emails.insert(String(searchable[swiftRange]).lowercased())
            }
        }
    }
    return Array(emails).sorted()
}

func largestComposeTextArea(_ nodes: [AXNode]) throws -> AXNode {
    let ranked = nodes.filter { $0.role == "AXTextArea" }.compactMap { node -> (AXNode, CGFloat)? in
        guard let frame = elementFrame(node.element), frame.width > 20, frame.height > 20 else { return nil }
        return (node, frame.width * frame.height)
    }.sorted { $0.1 > $1.1 }
    guard let selected = ranked.first, ranked.count == 1 || selected.1 > ranked[1].1 else {
        throw HelperError.message("Der Outlook-Mailtext ist nicht eindeutig auswählbar.")
    }
    return selected.0
}

func pasteFileAttachments(_ filePaths: [String], into element: AXUIElement) throws {
    guard !filePaths.isEmpty else { throw HelperError.message("Es wurden keine Anlagen übergeben.") }
    let urls = try filePaths.map { filePath -> NSURL in
        guard filePath.hasPrefix("/") else { throw HelperError.message("Anlagenpfad ist nicht absolut: \(filePath)") }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: filePath, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw HelperError.message("Anlage wurde nicht als Datei gefunden: \(filePath)")
        }
        return NSURL(fileURLWithPath: filePath)
    }
    let pasteboard = NSPasteboard.general
    let previous = snapshotPasteboard(pasteboard)
    pasteboard.clearContents()
    guard pasteboard.writeObjects(urls) else {
        restorePasteboard(pasteboard, snapshot: previous)
        throw HelperError.message("Die exakten Anlagendateien konnten nicht in die Zwischenablage gelegt werden.")
    }
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    try click(element)
    usleep(150_000)
    try keyboardEvent(125, flags: .maskCommand) // Ans Ende des Mailtexts, ohne den Inhalt zu markieren.
    usleep(100_000)
    try commandShortcut(9) // Befehl+V fügt exakt die übergebenen Datei-URLs als Anlagen ein.
    usleep(2_000_000)
    restorePasteboard(pasteboard, snapshot: previous)
}

struct ComposeSendExpectation: Decodable {
    let from: String
    let subject: String
    let to: [String]
    let attachments: [String]
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let command = arguments.first ?? "doctor"

    if command == "accessibility-status" {
        let shouldPrompt = arguments.contains("--prompt")
        let trusted: Bool
        if shouldPrompt {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            trusted = AXIsProcessTrustedWithOptions(options)
        } else {
            trusted = AXIsProcessTrusted()
        }
        try writeJSON(["trusted": trusted, "promptRequested": shouldPrompt])
        exit(0)
    }

    if command == "ente-auth-status" {
        try writeJSON(enteAuthStatus())
        exit(0)
    }

    if command == "ente-auth-type-panasonic-code" {
        try writeJSON(typePanasonicCodeFromEnte())
        exit(0)
    }

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
        activateApplication(app)
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

    if command == "find-app" {
        guard arguments.count >= 2 else { throw HelperError.message("find-app benötigt mindestens eine AX-Rolle.") }
        let role = arguments[1]
        let description = arguments.count >= 3 ? arguments[2] : ""
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: role, description: description) }
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

    if command == "value-app" {
        guard arguments.count >= 3 else { throw HelperError.message("value-app benötigt AX-Rolle und exakte Beschriftung.") }
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist appweit nicht eindeutig: \(found.count) Treffer.") }
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

    if command == "set-value-app" {
        guard arguments.count >= 4 else { throw HelperError.message("set-value-app benötigt AX-Rolle, exakte Beschriftung und Wert.") }
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist appweit nicht eindeutig: \(found.count) Treffer.") }
        let result = AXUIElementSetAttributeValue(found[0].element, kAXValueAttribute as CFString, arguments[3] as CFTypeRef)
        guard result == .success else { throw HelperError.message("Wert konnte appweit nicht gesetzt werden: AX-Fehler \(result.rawValue).") }
        try writeJSON(["updated": true, "element": dictionary(found[0]), "valueLength": arguments[3].count])
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
        if arguments[3].isEmpty { try keyboardEvent(51) } // Rückschritt löscht auch Empfänger-Chips
        else { try typeText(arguments[3]) }
        usleep(150_000)
        try keyboardEvent(36) // Eingabetaste
        usleep(250_000)
        try writeJSON(["updated": true, "confirmed": true, "element": dictionary(found[0]), "valueLength": arguments[3].count])
        exit(0)
    }

    if command == "replace-text-app-and-confirm" {
        guard arguments.count >= 4 else { throw HelperError.message("replace-text-app-and-confirm benötigt AX-Rolle, exakte Beschriftung und Wert.") }
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist appweit nicht eindeutig: \(found.count) Treffer.") }
        _ = AXUIElementSetAttributeValue(found[0].element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        try click(found[0].element)
        usleep(100_000)
        try commandShortcut(0) // Befehl+A
        if arguments[3].isEmpty { try keyboardEvent(51) }
        else { try typeText(arguments[3]) }
        usleep(150_000)
        try keyboardEvent(36)
        usleep(250_000)
        try writeJSON(["updated": true, "confirmed": true, "element": dictionary(found[0]), "valueLength": arguments[3].count])
        exit(0)
    }

    if command == "open-draft-search-result" {
        guard arguments.count >= 2 else { throw HelperError.message("open-draft-search-result benötigt den exakten Betreff.") }
        let expectedSubject = arguments[1]
        let subjectNeedle = "Betreff: \(expectedSubject),"
        let candidates = nodes.filter { node in
            node.role == "AXCell" && node.description.contains(subjectNeedle) && node.description.contains("Ordner: Entwürfe")
        }
        guard candidates.count == 1 else {
            throw HelperError.message("Entwurfsaktualisierung abgebrochen: Erwartet wurde genau ein Suchtreffer im Ordner Entwürfe, gefunden wurden \(candidates.count).")
        }
        let rowPath = Array(candidates[0].path.dropLast())
        let row = nodes.first { $0.role == "AXRow" && $0.path == rowPath }
        if let row {
            let selected = AXUIElementSetAttributeValue(row.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
            if selected != .success { try click(row.element) }
        } else {
            try click(candidates[0].element)
        }
        usleep(800_000)
        let refreshed = collect(focusedRoot(appElement))
        let subjectFields = refreshed.filter { matches($0, role: "AXTextField", description: "subjectTextField") }
        guard subjectFields.count == 1, safeValue(subjectFields[0].element) == expectedSubject else {
            throw HelperError.message("Entwurfsaktualisierung abgebrochen: Der ausgewählte Entwurf konnte nicht über seinen Betreff verifiziert werden.")
        }
        try writeJSON(["opened": true, "subject": expectedSubject, "searchResult": dictionary(candidates[0])])
        exit(0)
    }

    if command == "select-search-suggestion" {
        guard arguments.count >= 2 else { throw HelperError.message("select-search-suggestion benötigt den exakten Suchtext.") }
        let expected = arguments[1]
        let candidates = nodes.filter { node in
            node.role == "AXCell" && node.description.contains("Suchvorschlag") && node.description.contains(expected)
        }.sorted { $0.path.count < $1.path.count }
        guard let selected = candidates.first else { throw HelperError.message("Kein eindeutiger Outlook-Suchvorschlag gefunden.") }
        try click(selected.element)
        usleep(1_200_000)
        try writeJSON(["selected": true, "searchText": expected, "element": dictionary(selected)])
        exit(0)
    }

    if command == "compose-summary" {
        let composeRoot = focusedRoot(appElement)
        let composeNodes = collect(composeRoot, maxDepth: 22, maxNodes: 12000)
        let accountPickers = composeNodes.filter { matches($0, role: "AXPopUpButton", description: "accountPicker") }
        let subjectFields = composeNodes.filter { matches($0, role: "AXTextField", description: "subjectTextField") }
        guard accountPickers.count == 1 && subjectFields.count == 1 else {
            throw HelperError.message("Entwurfsprüfung abgebrochen: Das Verfassen-Fenster ist nicht eindeutig sichtbar.")
        }
        let emails = try composeRecipientEmails(in: composeNodes)
        let attachmentGrids = composeNodes.filter { $0.role == "AXGroup" && $0.identifier == "attachmentGrid" }
        let attachmentNodes = attachmentGrids.flatMap { grid in
            collect(grid.element, maxDepth: 10, maxNodes: 1000).filter { node in
                !node.description.isEmpty || !node.title.isEmpty || !safeValue(node.element).isEmpty
            }
        }
        try writeJSON([
            "account": safeValue(accountPickers[0].element),
            "subject": safeValue(subjectFields[0].element),
            "recipientEmails": emails,
            "attachmentNames": try xlsxNames(in: composeNodes),
            "attachmentGridCount": attachmentGrids.count,
            "attachmentNodes": attachmentNodes.map(dictionary),
            "focusedWindowTitle": focusedWindowTitle(appElement),
        ])
        exit(0)
    }

    if command == "paste-file-attachments" {
        guard arguments.count >= 2 else { throw HelperError.message("paste-file-attachments benötigt eine JSON-Datei.") }
        let data = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
        let filePaths = try JSONDecoder().decode([String].self, from: data)
        let composeRoot = focusedRoot(appElement)
        let composeNodes = collect(composeRoot, maxDepth: 22, maxNodes: 12000)
        let textArea = try largestComposeTextArea(composeNodes)
        try pasteFileAttachments(filePaths, into: textArea.element)
        let refreshed = collect(focusedRoot(appElement), maxDepth: 22, maxNodes: 12000)
        try writeJSON([
            "attached": true,
            "requestedCount": filePaths.count,
            "attachmentNames": try xlsxNames(in: refreshed),
            "focusedWindowTitle": focusedWindowTitle(appElement),
        ])
        exit(0)
    }

    if command == "send-verified-compose" {
        guard arguments.count >= 2 else { throw HelperError.message("send-verified-compose benötigt eine JSON-Datei.") }
        let data = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
        let expected = try JSONDecoder().decode(ComposeSendExpectation.self, from: data)
        let composeRoot = focusedRoot(appElement)
        let composeNodes = collect(composeRoot, maxDepth: 22, maxNodes: 12000)
        let accountPickers = composeNodes.filter { matches($0, role: "AXPopUpButton", description: "accountPicker") }
        let subjectFields = composeNodes.filter { matches($0, role: "AXTextField", description: "subjectTextField") }
        guard accountPickers.count == 1 && subjectFields.count == 1 else {
            throw HelperError.message("Versand abgebrochen: Das Outlook-Verfassen-Fenster ist nicht eindeutig sichtbar.")
        }
        let account = safeValue(accountPickers[0].element).lowercased()
        guard account.contains(expected.from.lowercased()) else {
            throw HelperError.message("Versand abgebrochen: Das erwartete Absenderkonto ist nicht ausgewählt.")
        }
        guard safeValue(subjectFields[0].element) == expected.subject else {
            throw HelperError.message("Versand abgebrochen: Der Betreff stimmt nicht exakt überein.")
        }
        let actualRecipients = try composeRecipientEmails(in: composeNodes)
        let expectedRecipients = expected.to.map { $0.lowercased() }
        guard expectedRecipients.allSatisfy({ actualRecipients.contains($0) }) else {
            throw HelperError.message("Versand abgebrochen: Die erwarteten An-Empfänger sind nicht vollständig sichtbar.")
        }
        let actualAttachments = Set(try xlsxNames(in: composeNodes))
        let expectedAttachments = Set(expected.attachments)
        guard !expectedAttachments.isEmpty && actualAttachments == expectedAttachments else {
            throw HelperError.message("Versand abgebrochen: Die sichtbaren XLSX-Anlagen stimmen nicht exakt mit dem Manifest überein.")
        }
        let containsPdf = composeNodes.contains { node in
            "\(node.title) \(node.description) \(safeValue(node.element))".lowercased().contains(".pdf")
        }
        guard !containsPdf else { throw HelperError.message("Versand abgebrochen: Im Entwurf wurde eine PDF-Anlage erkannt.") }
        let sendButtons = composeNodes.filter { node in
            guard node.role == "AXButton", (attribute(node.element, kAXEnabledAttribute) as? Bool ?? true) else { return false }
            let label = "\(node.title) \(node.description) \(node.identifier)".lowercased()
            return label == "senden  " || label == "send  " || label.contains("sendbutton") || label.split(separator: " ").contains("senden") || label.split(separator: " ").contains("send")
        }
        guard sendButtons.count == 1 else {
            throw HelperError.message("Versand abgebrochen: Outlooks Senden-Schaltfläche ist nicht eindeutig: \(sendButtons.count) Treffer.")
        }
        let windowCountBefore = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
        let pressResult = AXUIElementPerformAction(sendButtons[0].element, kAXPressAction as CFString)
        if pressResult != .success { try click(sendButtons[0].element) }
        usleep(1_500_000)
        let windowCountAfter = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement])?.count ?? 0
        let remainingCompose = collect(focusedRoot(appElement), maxDepth: 16, maxNodes: 6000)
            .filter { matches($0, role: "AXTextField", description: "subjectTextField") && safeValue($0.element) == expected.subject }
        guard remainingCompose.isEmpty && windowCountAfter < windowCountBefore else {
            throw HelperError.message("Versand konnte nicht bestätigt werden: Das Verfassen-Fenster ist weiterhin geöffnet.")
        }
        try writeJSON([
            "sent": true,
            "subject": expected.subject,
            "recipients": expectedRecipients,
            "attachments": Array(expectedAttachments).sorted(),
            "windowCountBefore": windowCountBefore,
            "windowCountAfter": windowCountAfter,
        ])
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
        activateApplication(app)
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

    if command == "paste-html-file-app" {
        guard arguments.count >= 4 else { throw HelperError.message("paste-html-file-app benötigt AX-Rolle, exakte Beschriftung und Dateipfad.") }
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist appweit nicht eindeutig: \(found.count) Treffer.") }
        let characterCount = try pasteHTMLFile(arguments[3], into: found[0].element)
        try writeJSON([
            "pasted": true,
            "characterCount": characterCount,
            "element": dictionary(found[0]),
        ])
        exit(0)
    }

    if command == "paste-html-file-app-largest" {
        guard arguments.count >= 4 else { throw HelperError.message("paste-html-file-app-largest benötigt AX-Rolle, exakte Beschriftung und Dateipfad.") }
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: arguments[1], description: arguments[2]) }
        let ranked = found.compactMap { node -> (AXNode, CGFloat)? in
            guard let frame = elementFrame(node.element), frame.width > 20, frame.height > 20 else { return nil }
            return (node, frame.width * frame.height)
        }.sorted { $0.1 > $1.1 }
        guard let selected = ranked.first, ranked.count == 1 || selected.1 > ranked[1].1 else {
            throw HelperError.message("Der Outlook-Mailtext ist appweit nicht eindeutig auswählbar: \(found.count) Treffer.")
        }
        let characterCount = try pasteHTMLFile(arguments[3], into: selected.0.element)
        try writeJSON(["pasted": true, "characterCount": characterCount, "element": dictionary(selected.0)])
        exit(0)
    }

    if command == "paste-text" {
        guard arguments.count >= 4 else { throw HelperError.message("paste-text benötigt AX-Rolle, exakte Beschriftung und Text.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        activateApplication(app)
        usleep(150_000)
        try pasteText(arguments[3], into: found[0].element)
        if AXUIElementPerformAction(found[0].element, kAXConfirmAction as CFString) != .success {
            try keyboardEvent(36) // Eingabetaste
        }
        usleep(250_000)
        try writeJSON(["pasted": true, "characterCount": arguments[3].count, "element": dictionary(found[0])])
        exit(0)
    }

    if command == "paste-text-app" {
        guard arguments.count >= 4 else { throw HelperError.message("paste-text-app benötigt AX-Rolle, exakte Beschriftung und Text.") }
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist appweit nicht eindeutig: \(found.count) Treffer.") }
        activateApplication(app)
        usleep(150_000)
        try pasteText(arguments[3], into: found[0].element)
        if AXUIElementPerformAction(found[0].element, kAXConfirmAction as CFString) != .success { try keyboardEvent(36) }
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

    if command == "press-visible" {
        guard arguments.count >= 3 else { throw HelperError.message("press-visible benötigt AX-Rolle und exakte Beschriftung.") }
        let found = nodes.filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist nicht eindeutig: \(found.count) Treffer.") }
        _ = AXUIElementPerformAction(found[0].element, "AXScrollToVisible" as CFString)
        usleep(350_000)
        let result = AXUIElementPerformAction(found[0].element, kAXPressAction as CFString)
        if result != .success { try click(found[0].element) }
        usleep(700_000)
        try writeJSON(["pressed": true, "element": dictionary(found[0])])
        exit(0)
    }

    if command == "inspect-message-attachments" {
        guard arguments.count >= 2 else { throw HelperError.message("inspect-message-attachments benötigt die exakte Nachrichtenbeschreibung.") }
        let found = nodes.filter { matches($0, role: "AXCell", description: arguments[1]) }
        guard found.count == 1 else { throw HelperError.message("Outlook-Nachricht ist nicht eindeutig: \(found.count) Treffer.") }
        _ = AXUIElementPerformAction(found[0].element, "AXScrollToVisible" as CFString)
        usleep(200_000)
        let result = AXUIElementPerformAction(found[0].element, kAXPressAction as CFString)
        if result != .success { try click(found[0].element) }
        usleep(500_000)
        let refreshed = collect(focusedRoot(appElement))
        let attachmentGroups = refreshed.filter { node in
            node.role == "AXGroup" && node.identifier == "_NS:136" && !node.description.isEmpty
        }
        let grids = refreshed.filter { node in
            node.role == "AXGroup" && node.identifier == "attachmentGrid"
        }
        try writeJSON([
            "opened": true,
            "message": dictionary(found[0]),
            "attachmentGrid": grids.first.map(dictionary) as Any,
            "attachments": attachmentGroups.map(dictionary),
        ])
        exit(0)
    }

    if command == "move-message-to-folder" {
        guard arguments.count >= 3 else { throw HelperError.message("move-message-to-folder benötigt die exakte Nachrichtenbeschreibung und den Zielordner.") }
        let messageDescription = arguments[1]
        let targetFolder = normalizedAXText(arguments[2])
        guard !targetFolder.isEmpty else { throw HelperError.message("Der Outlook-Zielordner fehlt.") }
        let found = nodes.filter { matches($0, role: "AXCell", description: messageDescription) }
        guard found.count == 1 else { throw HelperError.message("Outlook-Nachricht ist vor dem Verschieben nicht eindeutig: \(found.count) Treffer.") }
        _ = AXUIElementPerformAction(found[0].element, "AXScrollToVisible" as CFString)
        usleep(200_000)
        let selected = AXUIElementSetAttributeValue(found[0].element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
        if selected != .success { try click(found[0].element) }
        usleep(300_000)

        let selectedNodes = collect(focusedRoot(appElement), maxDepth: 18, maxNodes: 6000)
        let moveLabels = ["Verschieben", "Move"]
        let moveButtons = selectedNodes.filter { node in
            guard node.role == "AXButton" || node.role == "AXMenuButton" else { return false }
            let values = [node.description, node.title, safeValue(node.element)].map(normalizedAXText)
            return values.contains { value in moveLabels.contains(value) }
        }
        guard moveButtons.count == 1 else { throw HelperError.message("Outlooks Schaltfläche „Verschieben“ ist nicht eindeutig: \(moveButtons.count) Treffer.") }
        let moveResult = AXUIElementPerformAction(moveButtons[0].element, kAXPressAction as CFString)
        if moveResult != .success { try click(moveButtons[0].element) }
        usleep(500_000)

        let menuNodes = collect(appElement, maxDepth: 20, maxNodes: 8000)
        let folderCandidates = menuNodes.filter { node in
            guard ["AXMenuItem", "AXCell", "AXRow", "AXStaticText"].contains(node.role) else { return false }
            let values = [node.description, node.title, safeValue(node.element)].map(normalizedAXText)
            return values.contains(targetFolder)
        }
        guard folderCandidates.count == 1 else { throw HelperError.message("Outlooks Zielordner „\(targetFolder)“ ist im Verschieben-Menü nicht eindeutig: \(folderCandidates.count) Treffer.") }
        let folderResult = AXUIElementPerformAction(folderCandidates[0].element, kAXPressAction as CFString)
        if folderResult != .success { try click(folderCandidates[0].element) }
        usleep(900_000)

        let remaining = collect(focusedRoot(appElement), maxDepth: 18, maxNodes: 6000).filter {
            matches($0, role: "AXCell", description: messageDescription)
        }
        guard remaining.isEmpty else { throw HelperError.message("Die Outlook-Nachricht ist nach dem Verschieben weiterhin im Quellordner sichtbar.") }
        try writeJSON([
            "moved": true,
            "sourceMessage": messageDescription,
            "destinationFolder": targetFolder,
            "removedFromSource": true,
        ])
        exit(0)
    }

    if command == "download-open-message-attachments" {
        guard arguments.count >= 2 else { throw HelperError.message("download-open-message-attachments benötigt einen absoluten Zielordner.") }
        let destination = URL(fileURLWithPath: arguments[1]).standardizedFileURL.path
        guard destination.hasPrefix("/") else { throw HelperError.message("Der Outlook-Downloadordner muss absolut sein.") }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: destination, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw HelperError.message("Der Outlook-Downloadordner existiert nicht.")
        }

        let currentRoot = focusedRoot(appElement)
        let currentNodes = collect(currentRoot)
        let grids = currentNodes.filter { $0.role == "AXGroup" && $0.identifier == "attachmentGrid" }
        guard grids.count == 1 else { throw HelperError.message("Die geöffnete Outlook-Mail besitzt kein eindeutig sichtbares Anlagenfeld.") }
        let attachmentGroups = currentNodes.filter { node in
            node.role == "AXGroup" && node.identifier == "_NS:136" && !node.description.isEmpty
        }
        guard !attachmentGroups.isEmpty else { throw HelperError.message("In der geöffneten Outlook-Mail wurden keine Anlagen erkannt.") }
        let downloadButtons = currentNodes.filter { matches($0, role: "AXButton", description: "Alle herunterladen") }
        guard downloadButtons.count == 1 else { throw HelperError.message("Outlooks Schaltfläche „Alle herunterladen“ ist nicht eindeutig verfügbar.") }
        _ = AXUIElementPerformAction(downloadButtons[0].element, "AXScrollToVisible" as CFString)
        usleep(200_000)
        let pressResult = AXUIElementPerformAction(downloadButtons[0].element, kAXPressAction as CFString)
        if pressResult != .success { try click(downloadButtons[0].element) }

        var chooserVisible = false
        for _ in 0..<30 {
            usleep(100_000)
            let title = focusedWindowTitle(appElement)
            if title == "Verzeichnis wählen" || title == "Choose Directory" {
                chooserVisible = true
                break
            }
        }
        guard chooserVisible else { throw HelperError.message("Outlooks Verzeichnisauswahl wurde nicht sichtbar.") }

        try keyboardEvent(5, flags: [.maskCommand, .maskShift]) // Befehl+Umschalt+G
        usleep(250_000)
        try typeText(destination)
        try keyboardEvent(36) // Eingabe
        usleep(500_000)

        let chooserRoot = focusedRoot(appElement)
        let chooserNodes = collect(chooserRoot, maxDepth: 12, maxNodes: 2000)
        let chooseButtons = chooserNodes.filter { node in
            node.role == "AXButton" && (node.identifier == "OKButton" || node.description == "Auswählen" || node.title == "Auswählen" || node.description == "Choose" || node.title == "Choose")
        }
        guard chooseButtons.count == 1 else { throw HelperError.message("Der Zielordner konnte in Outlook nicht eindeutig bestätigt werden.") }
        let chooseResult = AXUIElementPerformAction(chooseButtons[0].element, kAXPressAction as CFString)
        if chooseResult != .success { try click(chooseButtons[0].element) }
        usleep(900_000)
        guard focusedWindowTitle(appElement) != "Verzeichnis wählen" else {
            throw HelperError.message("Outlooks Verzeichnisauswahl wurde nach der Bestätigung nicht geschlossen.")
        }
        try writeJSON([
            "downloadStarted": true,
            "destination": destination,
            "expectedAttachmentCount": attachmentGroups.count,
            "attachments": attachmentGroups.map(dictionary),
        ])
        exit(0)
    }

    if command == "inspect-message-attachments-file" {
        guard arguments.count >= 2 else { throw HelperError.message("inspect-message-attachments-file benötigt eine JSON-Datei.") }
        let data = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
        guard let descriptions = try JSONSerialization.jsonObject(with: data) as? [String] else {
            throw HelperError.message("Die Outlook-Nachrichtenliste ist ungültig.")
        }
        let messageNodes = nodes.filter { node in
            node.role == "AXCell" && (node.description.contains("Betreff:") || node.description.contains("Kein Betreff"))
        }
        let rowIndices = messageNodes.compactMap { $0.path.count >= 2 ? $0.path[$0.path.count - 2] : nil }
        let maximumRowIndex = max(1, rowIndices.max() ?? max(1, messageNodes.count - 1))
        var inspections: [[String: Any]] = []
        for description in descriptions {
            let original = messageNodes.filter { matches($0, role: "AXCell", description: description) }
            guard original.count == 1 else {
                inspections.append(["description": description, "error": "Outlook-Nachricht ist nicht eindeutig: \(original.count) Treffer."])
                continue
            }
            let rowIndex = original[0].path.count >= 2 ? original[0].path[original[0].path.count - 2] : 0
            var ratio = min(1.0, max(0.0, Double(rowIndex) / Double(maximumRowIndex)))
            var selectedNode: AXNode? = nil
            for _ in 0..<7 {
                let currentRoot = focusedRoot(appElement)
                if let scrollBar = descendant(currentRoot, path: [1, 6, 2, 0, 0, 0, 1, 1]) {
                    _ = AXUIElementSetAttributeValue(scrollBar, kAXValueAttribute as CFString, NSNumber(value: ratio))
                    usleep(120_000)
                }
                let messageListRoot = descendant(currentRoot, path: [1, 6, 2, 0, 0]) ?? currentRoot
                let listFrame = elementFrame(messageListRoot)
                let currentMessages = collect(messageListRoot, maxDepth: 8, maxNodes: 1800)
                let visibleMessages = currentMessages.filter { node in
                    guard node.role == "AXCell", (node.description.contains("Betreff:") || node.description.contains("Kein Betreff")),
                          let nodeFrame = elementFrame(node.element), let listFrame else { return false }
                    return nodeFrame.height > 2 && nodeFrame.midY >= listFrame.minY && nodeFrame.midY <= listFrame.maxY
                }
                if let exact = visibleMessages.first(where: { matches($0, role: "AXCell", description: description) }) {
                    selectedNode = exact
                    break
                }
                let visibleIndices = visibleMessages.compactMap { $0.path.count >= 2 ? $0.path[$0.path.count - 2] : nil }
                guard let minimum = visibleIndices.min(), let maximum = visibleIndices.max() else { break }
                if rowIndex < minimum {
                    ratio = max(0.0, ratio - max(0.01, Double(minimum - rowIndex) / Double(maximumRowIndex)))
                } else if rowIndex > maximum {
                    ratio = min(1.0, ratio + max(0.01, Double(rowIndex - maximum) / Double(maximumRowIndex)))
                } else {
                    break
                }
            }
            guard let selectedNode else {
                inspections.append(["description": description, "error": "Outlook-Nachricht konnte nicht zuverlässig in den sichtbaren Bereich gebracht werden."])
                continue
            }
            do { try click(selectedNode.element) }
            catch {
                let result = AXUIElementPerformAction(selectedNode.element, kAXPressAction as CFString)
                if result != .success {
                    inspections.append(["description": description, "error": "Outlook-Nachricht konnte nicht sichtbar ausgewählt werden."])
                    continue
                }
            }
            usleep(220_000)
            let refreshedRoot = focusedRoot(appElement)
            let previewRoot = descendant(refreshedRoot, path: [1, 6, 2, 0, 2]) ?? refreshedRoot
            let refreshed = collect(previewRoot, maxDepth: 12, maxNodes: 700)
            let attachmentGroups = refreshed.filter { node in
                node.role == "AXGroup" && node.identifier == "_NS:136" && !node.description.isEmpty
            }
            let grids = refreshed.filter { node in
                node.role == "AXGroup" && node.identifier == "attachmentGrid"
            }
            inspections.append([
                "description": description,
                "attachmentGrid": grids.first.map(dictionary) ?? NSNull(),
                "attachments": attachmentGroups.map(dictionary),
            ])
        }
        try writeJSON(["count": inspections.count, "inspections": inspections])
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
        let accountCells = nodes.filter { matchesSidebarLabel($0, label: accountName) }
        guard accountCells.count == 1 else {
            throw HelperError.message("Das Outlook-Konto ist in der Ordnerleiste nicht eindeutig sichtbar.")
        }
        guard let draftCell = sidebarFolder(after: accountCells[0], named: "Entwürfe", in: nodes) else {
            throw HelperError.message("Der Entwürfe-Ordner des Outlook-Kontos ist nicht sichtbar.")
        }
        if draftCell.role == "AXRow" {
            let selected = AXUIElementSetAttributeValue(draftCell.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
            if selected != .success { try click(draftCell.element) }
        } else {
            let rowPath = Array(draftCell.path.dropLast())
            let row = nodes.first { $0.role == "AXRow" && $0.path == rowPath }
            if let row {
                let selected = AXUIElementSetAttributeValue(row.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                if selected != .success { try click(row.element) }
            } else { try click(draftCell.element) }
        }
        usleep(900_000)
        try writeJSON(["opened": true, "account": accountName, "folder": draftCell.description, "element": dictionary(draftCell)])
        exit(0)
    }

    if command == "open-account-folder" {
        guard arguments.count >= 3 else { throw HelperError.message("open-account-folder benötigt Kontonamen und Ordnernamen.") }
        let accountName = arguments[1]
        let folderName = arguments[2]
        let currentTitle = focusedWindowTitle(appElement)
        if currentTitle.hasPrefix(folderName + " • " + accountName) || currentTitle == folderName + " - " + accountName {
            try writeJSON(["opened": true, "alreadyOpen": true, "account": accountName, "folder": folderName, "focusedWindowTitle": currentTitle])
            exit(0)
        }
        let outlookWindows = (attribute(appElement, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        var matchingWindows: [(window: AXUIElement, nodes: [AXNode], account: AXNode)] = []
        for window in outlookWindows {
            let windowNodes = collect(window)
            let accountCells = windowNodes.filter { matchesSidebarLabel($0, label: accountName) }
            if accountCells.count == 1 {
                matchingWindows.append((window: window, nodes: windowNodes, account: accountCells[0]))
            }
        }
        guard matchingWindows.count == 1 else {
            throw HelperError.message("Das Outlook-Konto ist in der Ordnerleiste nicht eindeutig sichtbar.")
        }
        let selectedWindow = matchingWindows[0]
        activateApplication(app)
        _ = AXUIElementSetAttributeValue(selectedWindow.window, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(selectedWindow.window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(250_000)
        guard let folderCell = sidebarFolder(after: selectedWindow.account, named: folderName, in: selectedWindow.nodes) else {
            throw HelperError.message("Der Outlook-Ordner \(folderName) des Kontos ist nicht sichtbar.")
        }
        if folderCell.role == "AXRow" {
            let selected = AXUIElementSetAttributeValue(folderCell.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
            if selected != .success { try click(folderCell.element) }
        } else {
            let rowPath = Array(folderCell.path.dropLast())
            let row = selectedWindow.nodes.first { $0.role == "AXRow" && $0.path == rowPath }
            if let row {
                let selected = AXUIElementSetAttributeValue(row.element, kAXSelectedAttribute as CFString, kCFBooleanTrue)
                if selected != .success { try click(row.element) }
            } else { try click(folderCell.element) }
        }
        usleep(900_000)
        try writeJSON(["opened": true, "account": accountName, "folder": folderCell.description, "element": dictionary(folderCell)])
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

    if command == "click-app" {
        guard arguments.count >= 3 else { throw HelperError.message("click-app benötigt AX-Rolle und exakte Beschriftung.") }
        let found = collect(appElement, maxDepth: 22, maxNodes: 12000).filter { matches($0, role: arguments[1], description: arguments[2]) }
        guard found.count == 1 else { throw HelperError.message("Bedienelement ist appweit nicht eindeutig: \(found.count) Treffer.") }
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
