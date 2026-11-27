#!/usr/bin/env bash
# node-datachannel (WebRTC: the phone's direct link to the PC) built for macOS 12, swapped into node_modules before
# electron-builder packs it (the mac release jobs; 2026-11-27).
#
# The npm prebuilts set no deployment target: darwin-arm64 is built on macos-14 (minos 14.0) and needs macOS 12.3
# (iostream instantiations libc++ exports from 12.3), darwin-x64 is cross-built on macos-latest (minos 26.0) and
# imports __cxa_init_primary_exception / exception_ptr::__from_native_exception_pointer (macOS 15.0). Below that the
# addon does not load and every phone link takes the relay. Here OpenSSL and the addon (with libdatachannel, libjuice,
# usrsctp, libsrtp) are compiled with MACOSX_DEPLOYMENT_TARGET=12.0, the same version as the installed package.
#
#   bash scripts/mac/build-datachannel.sh [cache dir, default vendor/datachannel]
#
# A build already in the cache dir (actions/cache keeps it between runs) is reused. Runs on the runner's own CPU.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ "$(uname -s)" = Darwin ] || { echo "build-datachannel: macOS only" >&2; exit 2; }

export MACOSX_DEPLOYMENT_TARGET=12.0
OPENSSL_TAG=openssl-3.5.9
cache="${1:-vendor/datachannel}"

ver=$(node -p "JSON.parse(require('fs').readFileSync('node_modules/node-datachannel/package.json','utf8')).version")
case "$(uname -m)" in
  arm64) arch=arm64; osx=arm64; ossl=darwin64-arm64-cc ;;
  x86_64) arch=x64; osx=x86_64; ossl=darwin64-x86_64-cc ;;
  *) echo "build-datachannel: unknown CPU $(uname -m)" >&2; exit 2 ;;
esac
pkg="node_modules/@node-datachannel/darwin-$arch"
[ -f "$pkg/node_datachannel.node" ] || { echo "build-datachannel: $pkg/node_datachannel.node is not installed" >&2; exit 1; }
out="$cache/$ver-$arch-$OPENSSL_TAG-macos$MACOSX_DEPLOYMENT_TARGET"

if [ -f "$out/node_datachannel.node" ]; then
  echo "build-datachannel: reusing $out"
else
  work="$(mktemp -d)"
  echo "build-datachannel: OpenSSL $OPENSSL_TAG ($ossl, macOS $MACOSX_DEPLOYMENT_TARGET)"
  git clone -q --depth 1 -b "$OPENSSL_TAG" https://github.com/openssl/openssl.git "$work/openssl"
  (
    cd "$work/openssl"
    ./Configure "$ossl" no-shared no-unit-test no-tests --prefix="$work/ossl" --libdir=lib > "$work/openssl.log"
    make -j"$(sysctl -n hw.ncpu)" >> "$work/openssl.log" 2>&1 || { tail -50 "$work/openssl.log"; exit 1; }
    make install_sw >> "$work/openssl.log" 2>&1
  )
  echo "build-datachannel: node-datachannel v$ver ($osx)"
  git clone -q --depth 1 -b "v$ver" https://github.com/murat-dogan/node-datachannel.git "$work/ndc"
  (
    cd "$work/ndc"
    # its own lockfile lags its optionalDependencies (npm ci refuses); upstream's CI uses npm install too. The
    # optional ones are the npm prebuilts this replaces
    npm install --ignore-scripts --omit=optional --no-audit --no-fund > /dev/null
    npx cmake-js build --arch="$arch" \
      --CDCMAKE_OSX_ARCHITECTURES="$osx" \
      --CDCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
      --CDOPENSSL_ROOT_DIR="$work/ossl" \
      --CDOPENSSL_USE_STATIC_LIBS=TRUE 2>&1 | tee "$work/ndc.log"
  )
  # the linker only warns when a static library inside was compiled for a later macOS (the result still says 12.0)
  if grep -q "built for newer macOS version" "$work/ndc.log"; then
    grep "built for newer macOS version" "$work/ndc.log" | head -20 >&2
    echo "build-datachannel: a part was built for a newer macOS than $MACOSX_DEPLOYMENT_TARGET" >&2
    exit 1
  fi
  mkdir -p "$out"
  cp "$work/ndc/build/Release/node_datachannel.node" "$out/"
fi

node scripts/mac/check-min-os.mjs "$out" --max "$MACOSX_DEPLOYMENT_TARGET"
cp "$out/node_datachannel.node" "$pkg/node_datachannel.node"
node -e "require('node-datachannel'); console.log('build-datachannel: loads in node ' + process.version)"
echo "build-datachannel: $pkg/node_datachannel.node is v$ver for macOS $MACOSX_DEPLOYMENT_TARGET"
