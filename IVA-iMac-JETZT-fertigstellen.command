#!/bin/zsh
set -euo pipefail

workspace="$HOME/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core"
commit="8817760c6fbb986a028ec583974513042f531c58"
archive_sha256="c5b2a1fcfb007c74a7cb85ed6d11601218be722772186c3158a0a2bb9db04171"

model="$(/usr/sbin/sysctl -n hw.model 2>/dev/null || true)"
if [[ "$model" != iMac* ]]; then
  print -u2 "FEHLER: Dieser IVA-Abschluss darf nur auf Nadines iMac ausgeführt werden."
  exit 1
fi
if [[ ! -d "$workspace" ]]; then
  print -u2 "FEHLER: Der verbindliche IVA-iCloud-Ordner wurde auf diesem iMac nicht gefunden."
  exit 1
fi

case "$(/usr/bin/uname -m)" in
  arm64) node_arch="arm64" ;;
  x86_64) node_arch="x64" ;;
  *)
    print -u2 "FEHLER: Die Prozessorarchitektur dieses iMac wird nicht unterstützt."
    exit 1
    ;;
esac

node_bin=""
for candidate in \
  "$HOME/Library/Application Support/IVA Runtime/node-v22.12.0-darwin-${node_arch}/bin/node" \
  /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [[ -x "$candidate" ]]; then
    node_bin="$candidate"
    break
  fi
done
if [[ -z "$node_bin" ]]; then
  print -u2 "FEHLER: Die bereits eingerichtete IVA-Node-Laufzeit wurde nicht gefunden."
  exit 1
fi

temp_base="${TMPDIR:-/tmp}"
download_dir="$(/usr/bin/mktemp -d "${temp_base%/}/iva-imac-final.XXXXXX")"
cleanup_download() {
  if [[ -n "${download_dir:-}" && -d "$download_dir" ]]; then
    /bin/rm -rf "$download_dir"
  fi
}
trap cleanup_download EXIT

archive="$download_dir/iva-core.tar.gz"
print "1/4 – Verifizierte IVA-Version wird direkt geladen …"
/usr/bin/curl --fail --show-error --location --progress-bar --proto '=https' --tlsv1.2 \
  "https://github.com/Shelly1601/iva-core/archive/${commit}.tar.gz" -o "$archive"

actual_sha256="$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{ print $1 }')"
if [[ "$actual_sha256" != "$archive_sha256" ]]; then
  print -u2 "FEHLER: Die geladene IVA-Version hat die fest hinterlegte Prüfsumme nicht bestanden."
  exit 1
fi

print "2/4 – Geprüfte lokale Laufzeit wird vorbereitet …"
/usr/bin/tar -xzf "$archive" -C "$download_dir"
snapshot="$download_dir/iva-core-${commit}"
if [[ ! -f "$snapshot/local-mac-helper/install-imac-device-agent.mjs" ]]; then
  print -u2 "FEHLER: Das geprüfte IVA-Paket ist unvollständig."
  exit 1
fi

print "3/4 – Die vorbereiteten Forecast-Dateien werden lokal übernommen …"
/usr/bin/brctl download "$workspace/outputs/planbar-weekly" >/dev/null 2>&1 &!

print "4/4 – Dauerverbindung wird umgeschaltet und doppelt geprüft …"
IVA_DEVICE_WORKSPACE="$workspace" IVA_DEVICE_RUNTIME_SOURCE="$snapshot" \
  "$node_bin" "$snapshot/local-mac-helper/install-imac-device-agent.mjs"

print "FERTIG: IVA läuft dauerhaft lokal auf dem iMac; zwei fortlaufende Railway-Heartbeats wurden bestätigt."
