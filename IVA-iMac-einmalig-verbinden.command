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

print "IVA-DIREKTSTART 260C479 – einheitliche iMac-Steuerung, iCloud-Retry und lokale Laufzeit werden eingerichtet."

# Holt bei Bedarf die bereits in iCloud veröffentlichte Agent-Version lokal auf
# den iMac. Die Downloads laufen im Hintergrund, damit das Fenster nie wieder
# scheinbar ohne Rückmeldung hängen bleibt.
print "IVA lädt die aktuelle iMac-Komponente aus iCloud …"
/usr/bin/brctl download "$workspace/local-mac-helper" >/dev/null 2>&1 &!
/usr/bin/brctl download "$workspace/local-mac-helper/install-imac-device-agent.mjs" >/dev/null 2>&1 &!
/usr/bin/brctl download "$workspace/local-mac-helper/device-agent.mjs" >/dev/null 2>&1 &!
/usr/bin/brctl download "$workspace/local-mac-helper/device-agent-runner.mjs" >/dev/null 2>&1 &!
/usr/bin/brctl download "$workspace/local-mac-helper/device-agent-launchd.mjs" >/dev/null 2>&1 &!
/usr/bin/brctl download "$workspace/outputs/planbar-weekly" >/dev/null 2>&1 &!

for attempt in {1..60}; do
  if /usr/bin/grep -q "imac-local-v4" "$workspace/local-mac-helper/device-agent.mjs" 2>/dev/null; then
    break
  fi
  if (( attempt % 10 == 0 )); then
    print "iCloud-Synchronisation läuft weiter …"
  fi
  /bin/sleep 1
done

if ! /usr/bin/grep -q "imac-local-v4" "$workspace/local-mac-helper/device-agent.mjs" 2>/dev/null; then
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

bootstrap_commit="260c479a96fb6179312d3dd9a04dff6fc97b3103"
bootstrap_sha256="8a3a8b7f625c9801d65f60e47968b71c1fe0879dd66bf17f39102c5dd06fc6ba"
bootstrap_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/iva-imac-bootstrap.XXXXXX")"
cleanup_bootstrap() {
  if [[ -n "${bootstrap_dir:-}" && -d "$bootstrap_dir" ]]; then
    /bin/rm -rf "$bootstrap_dir"
  fi
}
trap cleanup_bootstrap EXIT
bootstrap_archive="$bootstrap_dir/iva-core.tar.gz"

print "Aktuelle Komponente geladen. Geprüftes IVA-Paket wird direkt geladen …"
/usr/bin/curl --fail --show-error --location --progress-bar --proto '=https' --tlsv1.2 \
  "https://github.com/Shelly1601/iva-core/archive/${bootstrap_commit}.tar.gz" -o "$bootstrap_archive"
actual_bootstrap_sha256="$(/usr/bin/shasum -a 256 "$bootstrap_archive" | /usr/bin/awk '{ print $1 }')"
if [[ "$actual_bootstrap_sha256" != "$bootstrap_sha256" ]]; then
  print -u2 "FEHLER: Das direkt geladene IVA-Paket hat die fest hinterlegte SHA-256-Prüfsumme nicht bestanden."
  exit 1
fi
/usr/bin/tar -xzf "$bootstrap_archive" -C "$bootstrap_dir"
bootstrap_source="$bootstrap_dir/iva-core-${bootstrap_commit}"

print "IVA richtet jetzt die vollständig lokale Dauerverbindung ein …"
IVA_DEVICE_WORKSPACE="$workspace" IVA_DEVICE_RUNTIME_SOURCE="$bootstrap_source" \
  "$node_bin" "$bootstrap_source/local-mac-helper/install-imac-device-agent.mjs"

print "IVA ist jetzt dauerhaft mit diesem iMac und dem zentralen iCloud-Ordner verbunden. Zwei fortlaufende Railway-Heartbeats wurden bestätigt."
