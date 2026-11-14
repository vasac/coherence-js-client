<!--
Copyright (c) 2020, 2023, Oracle and/or its affiliates.

Licensed under the Universal Permissive License v 1.0 as shown at
https://oss.oracle.com/licenses/upl.
 -->

# Developing Coherence JavaScript Client

### Requirements
* Node `22.9.0` or later in the `22.x` line, `24.x`, or `26.x`; use the latest patch release of a supported line. Release builds use Node `26.x` LTS.
* npm `11.20.0`, pinned in `package.json` and installed explicitly by CI.
* Docker with Compose for the integration tests. Linux/macOS builds also need `curl`, `tar`, and network access for dependency installation and the verified JavaScript generator download.

Node 20 is end-of-life and is no longer supported. CI tests Node `22.x`, `24.x`, and `26.x`
against Coherence `22.06.12`, `14.1.2-0-3`, and `25.03.2`, including TLS and discovery tests.

npm `11.20.0` supports Node `^20.17.0 || >=22.9.0`; the Node 22 minimum above keeps
the same npm version usable across our supported lines. npm 12 requires newer patches
(`^22.22.2 || ^24.15.0 || >=26.0.0`), so it is not the build baseline.
See the [npm 11 engine declaration](https://github.com/npm/cli/blob/v11.20.0/package.json),
[npm 12 engine declaration](https://github.com/npm/cli/blob/v12.2.2/package.json), and
[Node release schedule](https://github.com/nodejs/Release#release-schedule).

### Runnable NPM Scripts
* `compile` - compiles the TypeScript sources to the `lib` directory
* `clean` - removes all generated code, coverage, and documentation artifacts
* `full-clean` - runs `clean` and removes the local `node_modules` directory 
* `test-protobuf` - runs the server-free protobuf wire-format and recursion-limit regressions
* `test` - runs the unit and integration tests
* `test-cycle` - starts the cluster and if successful, runs the unit tests.  After the cluster will be stopped.
* `coverage` - runs the unit tests and gathers coverage metrics (results found in `coverage` directory)
* `coh-up` - starts a two-member Coherence cluster for testing/developing against
* `coh-down` - stops the previously started Coherence cluster
* `dist` - creates a test distribution for inspection prior to publish

### Project Structure
* `bin` - various shell scripts that will be called by npm
* `etc` - contains the ProtoBuff .protoc files and other various files
* `src` - TypeScript source files and related resources
* `test` - contains the library test cases in plain JavaScript

### Building the Project

From the project root, select a supported Node version, then run:

```bash
npm install --global npm@11.20.0
npm ci
npm run compile
```

`npm ci` removes any existing `node_modules`, installs the exact committed dependency
graph, and fails if `package.json` and `package-lock.json` disagree. It does not update
the lockfile. Use it for fresh checkouts and when switching Node versions; an old local
installation is not evidence of the committed baseline.

Installation runs `prepare`, which verifies the vendored `etc/proto/messages.proto`
and `services.proto`, generates `src/grpc` and `lib/grpc`, and resets `etc/jvm-args.txt`
from `etc/jvm-args-clear.txt`. Preserve local JVM argument customizations before
installing. `--ignore-scripts` skips required generation and is not a complete build.

The schemas are byte-for-byte copies from Coherence `22.06.10`, commit
`4692ec775ab1710dc746e9752f04ff9fc763243c`. `etc/proto/manifest.json` records their
immutable source and SHA-256 hashes. This migration changes the runtime and code
generation, without changing schema fields, tags, service names, or RPC paths.
The manifest also checks the imported `google/protobuf/empty.proto` and
`wrappers.proto` supplied by the locked grpc-tools compiler against the upstream
protobuf 3.19.1 copies.

`bin/generate-grpc.js` downloads the official `protoc-gen-js` **4.0.3** archive,
checks the committed SHA-256 digest from the upstream GitHub release metadata before
extraction, and verifies the cached archive on every generation. The manifest covers
Linux x64/arm64/ia32/ppc64/s390x and macOS x64/arm64; unlisted build platforms fail
explicitly. Runtime consumers use the generated CommonJS files and need no native
generator, build scripts, or compatibility preload shim. The npm `protoc-gen-js`
wrapper was inspected but is not used: its install hook downloads a binary without
checking a committed digest. Downloading the official archive directly avoids that
extra dependency and keeps verification in this repository.

The locked grpc-tools compiler and gRPC plugin still generate the existing gRPC
service bindings. The JavaScript plugin is selected as `protoc-gen-coherence-js`,
with `--coherence-js_out`. This alias is necessary because protoc's built-in `js`
generator takes precedence over `--plugin=protoc-gen-js=...`; merely specifying that
path still generates obsolete `readPackedInt64()` calls. Modern output uses
`readPackableInt64Into()` for packed and unpacked filter IDs.

`grpc_tools_node_protoc_ts` remains at 5.3.3, with narrowly scoped overrides to the
same protobuf 4.0.3 runtime and Handlebars 4.7.10. Generation, project compilation,
and strict consumer compilation qualify those overrides. The protobuf typings
remain at their existing version and are now a production dependency because public
declarations import them. No obsolete protobuf runtime remains in the locked tree.

Generation stages all JavaScript and declarations before replacing the previous
output; failed downloads, checksum mismatches, and plugin failures fail the build
and leave that output intact. Temporary staging files are removed on failure.
`npm run grpc` reproduces the output, and reuses the verified archive under
`node_modules/.cache/coherence-protobuf`. Delete that cache to force a download.
Generated `src/grpc` and `lib` stay ignored. Generated declarations are copied into
both `src/grpc` for project compilation and `lib/grpc` for package consumers.
`npm pack` regenerates and compiles before packing, including the generated code and
declarations. A separate system installation of protoc is unnecessary.

When intentionally updating a schema or generator, review its upstream source,
update the vendored files/version and manifest digests together, and repeat the
wire, security, integration, deterministic-generation, and packed-consumer checks.
The runtime is pinned to 4.0.3, which fixes
[GHSA-5h29-r2cp-hfmr](https://github.com/protocolbuffers/protobuf-javascript/security/advisories/GHSA-5h29-r2cp-hfmr).
Scanner output alone does not establish that this fix is present.

The direct, pinned `@types/node` dependency stays on major 22 so builds on Node 24/26
also check against the minimum supported runtime major. TypeScript remains at the
locked version; TypeDoc is pinned and locked so generating release documentation
does not require an additional dependency installation.

For intentional dependency changes, use npm `11.20.0` and preserve lockfile format 2:
`npm install --package-lock-only --ignore-scripts --lockfile-version=2 <package-spec>`
(add `--save-dev --save-exact` for pinned development tools). Review the lockfile diff,
then run `npm ci` and the relevant build/tests. Existing dependency audit findings are
tracked separately from this runtime/build baseline.

### Running the Unit Tests
`npm run test-protobuf` runs the server-free wire and security regressions. Against
a running test server, use `npm exec -- mocha test/protobuf-listener-tests.js --exit`
for the focused listener regression. It verifies insert/update/delete delivery to
two matching filters and a key listener, observes multiple filter IDs in a single
server response, and checks delivery after removing listeners. Both files also run
in the regular unit/integration suite.

* run `npm run coh-up` - this starts a Coherence test Docker container.  This instance exposes the `grpc` port `1408` and exposes port `5005` for java debugging of the Coherence instance.  To view the JSON payloads being sent to Coherence, check the docker container log for the instance this command started.
* run `npm run test` - this will run all unit tests.  You may optionally run the tests individually via an IDE as long as the Coherence container mentioned in the previous step was started.
* run `npm run coh-down` when testing is complete and the Coherence test container is no longer needed.

The above can also be shortened to:
* `npm run test-cycle` - this will start the cluster, run test tests if the cluster start was successful, and then stop the cluster
* `npm run test-cycle-tls` - The same as `test-cycle`, but will use TLS

However, if developing new functionality or tests, the manual start of the cluster using `coh-up` may be preferred as
it avoids restarting the cluster allowing for quicker development times.

**Important!** The local cluster scripts default to Coherence `22.06.11`. CI explicitly
sets `COHERENCE_VERSION` to each version listed above. To use a different Coherence
version locally, prefix the calls with, or export `COHERENCE_VERSION=<desired-version>`.
For example:
```bash
COHERENCE_VERSION=25.03.2 npm run test-cycle
```

### Generating Documentation
* After `npm ci` and `npm run compile`, run `npm exec -- typedoc` from the project root using the locked TypeDoc and TypeScript versions. The generated documentation
  will be available in the `docs` directory.

### Code Style
* Currently based on https://google.github.io/styleguide/jsguide#formatting

### FAQ
* Question:  How do I use the library locally in another project for testing purposes?
> Answer: First, run `npm link` within the `coherence-js-client` project to create a global NPM reference.
> then, from the project you want to use the library with, run `npm link @oracle/coherence` which
> will install the library for use with that project
