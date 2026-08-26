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
/usr/bin/brctl download "$workspace/local-mac-helper/planbar-forecast-mail.mjs" >/dev/null 2>&1 || true
/usr/bin/brctl download "$workspace/outputs/planbar-weekly" >/dev/null 2>&1 || true

for _ in {1..30}; do
  if /usr/bin/grep -q "imac-local-v3" "$workspace/local-mac-helper/device-agent.mjs" 2>/dev/null; then
    break
  fi
  /bin/sleep 1
done

if ! /usr/bin/grep -q "imac-local-v3" "$workspace/local-mac-helper/device-agent.mjs" 2>/dev/null; then
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
  node_version="v22.12.0"
  case "$(/usr/bin/uname -m)" in
    arm64) node_arch="arm64" ;;
    x86_64) node_arch="x64" ;;
    *)
      print -u2 "FEHLER: Die Prozessorarchitektur dieses iMac wird nicht unterstützt."
      exit 1
      ;;
  esac
  node_folder="node-${node_version}-darwin-${node_arch}"
  runtime_root="$HOME/Library/Application Support/IVA Runtime"
  node_dir="$runtime_root/$node_folder"
  node_bin="$node_dir/bin/node"

  if [[ ! -x "$node_bin" ]]; then
    print "Node.js wird einmalig und ohne Administratorrechte für IVA eingerichtet …"
    temp_base="${TMPDIR:-/tmp}"
    download_dir="$(/usr/bin/mktemp -d "${temp_base%/}/iva-node.XXXXXX")"
    cleanup_download() {
      if [[ -n "${download_dir:-}" && -d "$download_dir" ]]; then
        /bin/rm -rf "$download_dir"
      fi
    }
    trap cleanup_download EXIT
    archive_name="${node_folder}.tar.gz"
    dist_url="https://nodejs.org/dist/${node_version}"

    /usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "$dist_url/$archive_name" -o "$download_dir/$archive_name"
    /usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "$dist_url/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"

    expected_hash="$(/usr/bin/awk -v file="$archive_name" '$2 == file { print $1; exit }' "$download_dir/SHASUMS256.txt")"
    actual_hash="$(/usr/bin/shasum -a 256 "$download_dir/$archive_name" | /usr/bin/awk '{ print $1 }')"
    if [[ -z "$expected_hash" || "$actual_hash" != "$expected_hash" ]]; then
      print -u2 "FEHLER: Die heruntergeladene Node.js-Laufzeit hat die offizielle Prüfsumme nicht bestanden."
      exit 1
    fi

    /usr/bin/tar -xzf "$download_dir/$archive_name" -C "$download_dir"
    /bin/mkdir -p "$runtime_root"
    /bin/rm -rf "$node_dir"
    /bin/mv "$download_dir/$node_folder" "$node_dir"
  fi
fi

cd "$workspace"
"$node_bin" local-mac-helper/cli.mjs install-imac-device-agent --commit

print "IVA ist jetzt dauerhaft mit diesem iMac und dem zentralen iCloud-Ordner verbunden. Zwei fortlaufende Railway-Heartbeats wurden bestätigt."
