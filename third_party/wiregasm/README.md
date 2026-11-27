# Bundled packet decoder

Hopline 1.2 includes Wiregasm 2.0.0 with Wireshark 4.6.10. The npm release of Wiregasm 2.0.0 contains Wireshark 4.6.9. The local package `2.0.0-hopline.1` carries the upstream security update and works in a clean checkout on each supported OS. npm verifies the archive against the integrity value in the lockfile. [Wireshark release notes](https://www.wireshark.org/news/20261118) · [Upstream source](https://github.com/good-tools/wiregasm/tree/eb65cf6644e012eb365f5d2d30ac4f0d5b8f213a)

## Contents and provenance

The JavaScript wrapper and types come from the published `@goodtools/wiregasm@2.0.0` package. The three runtime files under `dist/` (`wiregasm.js`, `wiregasm.wasm` and `wiregasm.data`) come from upstream's successful build of commit `eb65cf6644e012eb365f5d2d30ac4f0d5b8f213a` on its default branch. The ZIP artifact named `lib` has SHA-256 `006493218733dc994ebaf63d50a7b1e43763992ecddaae602174a96777707f0d`. Hopline packages the uncompressed runtime files and the original GPL license. [Upstream build](https://github.com/good-tools/wiregasm/actions/runs/45887360056) · [Changes since 2.0.0](https://github.com/good-tools/wiregasm/compare/v2.0.0...eb65cf6644e012eb365f5d2d30ac4f0d5b8f213a)

## Build the decoder from source

The Hopline release includes a decoder source archive with build scripts, patches and upstream library sources. Extract it and open its top-level directory. With Docker, Make, Node 22 or later and npm installed, run the following. [Decoder source archive](https://github.com/manuutr/hopline-terminal/releases/download/v1.2.1/wiregasm-wireshark-4.6.10-source.tar.gz)

```sh
npm ci
make docker
npm run build
rm -f dist/wiregasm.wasm.gz dist/wiregasm.data.gz
npm pkg set version=2.0.0-hopline.1 gitHead=eb65cf6644e012eb365f5d2d30ac4f0d5b8f213a
npm pack --ignore-scripts
```

The resulting tarball can replace the one in this directory. For a new decoder build, update the package version, archive path and lockfile together. Verify the DNS example on the desktop and run the packaged application's `--smoke` check before release. [Hopline build instructions](../../README.md#build-it-yourself) · [Wiregasm build reference](https://github.com/good-tools/wiregasm/blob/eb65cf6644e012eb365f5d2d30ac4f0d5b8f213a/CONTRIBUTING.md)
