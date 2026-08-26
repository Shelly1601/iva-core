#!/bin/zsh
set -euo pipefail

workspace="$HOME/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core"

model="$(/usr/sbin/sysctl -n hw.model 2>/dev/null || true)"
if [[ "$model" != iMac* ]]; then
  print -u2 "FEHLER: Dieser einmalige IVA-Start darf nur auf Nadines iMac ausgeführt werden."
  exit 1
fi

if [[ ! -d "$workspace" ]]; then
  print -u2 "FEHLER: Der verbindliche IVA-iCloud-Ordner wurde auf diesem iMac nicht gefunden."
  exit 1
fi

# Holt bei Bedarf die bereits in iCloud veröffentlichte Agent-Version lokal auf
# den iMac. Der Aufruf verändert keine Nutzerdaten und benötigt kein Passwort.
/usr/bin/brctl download "$workspace/local-mac-helper/device-agent.mjs" >/dev/null 2>&1 || true
/usr/bin/brctl download "$workspace/local-mac-helper/device-agent-runner.mjs" >/dev/null 2>&1 || true
/usr/bin/brctl download "$workspace/local-mac-helper/device-agent-launchd.mjs" >/dev/null 2>&1 || true

for _ in {1..30}; do
  if /usr/bin/grep -q "imac-icloud-v2" "$workspace/local-mac-helper/device-agent.mjs" 2>/dev/null; then
    break
  fi
  /bin/sleep 1
done

if ! /usr/bin/grep -q "imac-icloud-v2" "$workspace/local-mac-helper/device-agent.mjs" 2>/dev/null; then
  print -u2 "FEHLER: Die aktuelle IVA-Agent-Version ist auf diesem iMac noch nicht aus iCloud geladen worden."
  exit 1
fi

node_bin=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [[ -x "$candidate" ]]; then
    node_bin="$candidate"
    break
  fi
done

if [[ -z "$node_bin" ]]; then
  print -u2 "FEHLER: Node.js wurde auf dem iMac nicht gefunden."
  exit 1
fi

cd "$workspace"
"$node_bin" local-mac-helper/cli.mjs install-imac-device-agent --commit

print "IVA ist jetzt dauerhaft mit diesem iMac und dem zentralen iCloud-Ordner verbunden."
