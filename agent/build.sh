#!/usr/bin/env bash
# Compile l'agent pour toutes les architectures servies par le hub (agent/dist).
# La version de l'agent (agent/VERSION, X.Y.Z) est indépendante de celle de l'application.
#   ./agent/build.sh         : build +1 (X.Y.Z+1) si les sources ont changé depuis le dernier build, sinon rien
#   ./agent/build.sh minor   : X.Y+1.0, puis compile
#   ./agent/build.sh major   : X+1.0.0, puis compile
# Empreinte des sources du dernier build dans agent/.build-hash (non versionné). Absente (clone neuf, CI) :
# compile la version courante sans l'incrémenter.
set -euo pipefail
cd "$(dirname "$0")"

# os/arch -> dist/homelab-agent-<os>-<arch>[.exe]
TARGETS="linux/amd64 linux/arm64 windows/amd64"
bump=${1:-build}

version=$(cat VERSION)
[[ $version =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "❌ agent/VERSION invalide : « $version » (attendu X.Y.Z)"; exit 1; }
major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} build=${BASH_REMATCH[3]}

# only what ends up in the binary: tests excluded
src=$(sha256sum go.mod go.sum $(ls *.go | grep -v '_test\.go$' | sort) | sha256sum | cut -d' ' -f1)
last=$(cat .build-hash 2>/dev/null || true)

case $bump in
    build) if [ -n "$last" ] && [ "$last" != "$src" ]; then version="$major.$minor.$((build + 1))"; fi ;;
    minor) version="$major.$((minor + 1)).0" ;;
    major) version="$((major + 1)).0.0" ;;
    *) echo "Usage : $0 [minor|major]"; exit 2 ;;
esac

out() { echo "dist/homelab-agent-${1%/*}-${1#*/}$([ "${1%/*}" = windows ] && echo .exe)"; }

uptodate=$([ "$last" = "$src" ] && [ "$version" = "$(cat dist/VERSION 2>/dev/null)" ] && echo 1 || true)
for t in $TARGETS; do [ -f "$(out "$t")" ] || uptodate=; done
if [ -n "$uptodate" ]; then
    echo "agent $version à jour (sources inchangées)"
    exit 0
fi

# -buildvcs=false: the git revision must not change the binary (its hash marks the agent outdated)
release_key=${RELEASE_KEY:-$HOME/.config/homelab-manager/release.key}
release_pub=""
if [ -f "$release_key" ] && [ -f release.pub ]; then
    release_pub=$(cat release.pub)
    if [ "$(go run ./cmd/hm-sign pub -key "$release_key")" != "$release_pub" ]; then
        echo "❌ $release_key ne correspond pas à agent/release.pub" >&2
        exit 1
    fi
else
    echo "⚠️  Pas de clé de release ($release_key) : agents de développement non signés"
fi
for t in $TARGETS; do
    echo "agent $version $t"
    ldflags="-s -w -X main.version=$version"
    if [ -n "$release_pub" ]; then
        ldflags="$ldflags -X main.releasePubKey=$release_pub"
    fi
    CGO_ENABLED=0 GOOS=${t%/*} GOARCH=${t#*/} go build -trimpath -buildvcs=false \
        -ldflags "$ldflags" -o "$(out "$t")" .
done
if [ -n "$release_pub" ]; then
    for t in $TARGETS; do
        go run ./cmd/hm-sign sign -key "$release_key" "$(out "$t")"
    done
fi
echo "$version" > VERSION
echo "$version" > dist/VERSION
echo "$src" > .build-hash
