<!--
Copyright (c) 2020, 2026, Oracle and/or its affiliates.

Licensed under the Universal Permissive License v 1.0 as shown at
https://oss.oracle.com/licenses/upl.
 -->

# Developing Coherence JavaScript Client

### Requirements
* For development and tests, Node `22.12.0` or later in the `22.x` line, `24.x`, or `26.x`; use the latest patch release of a supported line. Mocha 12 needs `require(esm)` support. The published client's runtime floor remains `22.9.0`; development tools are not installed by consumers. Release builds use Node `26.x` LTS.
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
* `test-tooling` - checks Mocha discovery/exclusions, NYC file selection, and TypeDoc filtering without a Coherence server
* `test-resolver-unit` - runs discovery regressions with loopback NameService and gRPC peers; no Coherence cluster is required
* `test-resolver` - runs those regressions and discovery integration tests against local and foreign Coherence clusters
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

Installation runs `prepare`, which applies the checked TypeDoc compatibility patch described below, verifies the vendored `etc/proto/messages.proto`
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
also check against the minimum supported runtime major. TypeScript is pinned to
**6.0.3**, the intermediate target supported by
[TypeDoc 0.28.20's published peer range](https://github.com/TypeStrong/typedoc/blob/v0.28.20/package.json).
TypeScript 7 is a separate migration. Compilation keeps strict checking, ES2015
output, CommonJS modules, declarations and source maps. The redundant
`downlevelIteration` option was removed because
[TypeScript 6 deprecates it](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html#deprecated---downleveliteration).
TypeDoc is pinned and locked so generating release documentation does not require
an additional dependency installation.

For intentional dependency changes, use npm `11.20.0` and preserve lockfile format 2:
`npm install --package-lock-only --ignore-scripts --lockfile-version=2 <package-spec>`
(add `--save-dev --save-exact` for pinned development tools). Review the lockfile diff,
then run `npm ci` and the relevant build/tests, including `test-tooling` when changing
file matching or documentation tools. Review the override conditions and repeat the
security and compatibility checks recorded below.

The gRPC runtime is pinned to `@grpc/grpc-js` **1.14.7**, verified against npm's
`latest` metadata on 14 November 2026. Discovery uses the exported `experimental`
resolver interfaces, whose contract may change between minor releases, so review
that contract when upgrading. The resolver reports endpoints and `UNAVAILABLE`
errors through the callable `ResolverListener`, using the exported `StatusOr`
helpers. A result rejected by the load balancer is retried with gRPC's backoff
helper and the channel's initial/maximum reconnect backoff options. No private
gRPC module imports are required.

`@grpc/proto-loader` is needed transitively by gRPC, but is not used directly by
this client. The lockfile contains one loader, `0.8.1`, using protobufjs `7.6.6`
within its supported major range. This is separate from the generated Coherence
messages, which continue to use `google-protobuf` `4.0.3`.

### Running the Unit Tests
`npm run test-protobuf` runs the server-free wire and security regressions. Against
a running test server, use `npm exec -- mocha test/protobuf-listener-tests.js --exit`
for the focused listener regression. It verifies insert/update/delete delivery to
two matching filters and a key listener, observes multiple filter IDs in a single
server response, and checks delivery after removing listeners. Both files also run
in the regular unit/integration suite.

`npm run test-resolver-unit` also runs without a Coherence server. It tests actual
TCP framing, valid and malformed discovery responses, foreign lookup, refused and
closed connections, the 10-second socket inactivity timeout, retries, repeated
resolution, and cancellation. Real gRPC servers and `Session`/`NamedMap` calls
exercise round-robin selection, failover, rediscovery at a new proxy port, lifecycle
events, and shutdown. This command does not force process exit, so leaked sockets
or referenced retry timers can keep it from completing.

For the existing discovery integration tests, run two local Coherence clusters
sharing the default NameService port `7574`, with loopback proxy addresses. The
default expectations match the discovery CI workflow: proxies on `10000` and
`10001`, with the foreign cluster named `grpc-cluster2`. Run `npm run test-resolver`.
For isolated local cluster names or proxy ports, set
`COHERENCE_DISCOVERY_PROXY_PORT`, `COHERENCE_DISCOVERY_FOREIGN_CLUSTER`, and
`COHERENCE_DISCOVERY_FOREIGN_PORT` to match your test clusters. These variables
configure test expectations only; they do not change the client defaults.

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

### Development dependency maintenance

The 14 November 2026 development-tree update selected these published releases:

| Tool | Version | Selection |
| --- | --- | --- |
| Mocha | 12.0.3 | Current release; removes obsolete dependencies. Review the [Mocha 12 migration guide](https://mochajs.org/blog/mocha-12-stable/), including its development-only Node floor. |
| NYC | 18.0.0 | Current release; [upstream updated its old glob/process dependencies](https://github.com/istanbuljs/nyc/releases/tag/nyc-v18.0.0). |
| TypeScript / TypeDoc | 6.0.3 / 0.28.20 | Latest stable 6.x compiler and current documentation release, within the published peer range. |
| grpc-tools / grpc_tools_node_protoc_ts | 1.13.1 / 5.3.3 | Current releases; preserve the qualified compiler, schemas and declarations. |
| @types/node | 22.20.5 | Preserve the pinned minimum-runtime-major typings. |

Release tags, dependency constraints and engines were checked using npm registry
metadata through the approved registry mirror. Repository searches found no use of
the direct `glob-parent`, `ts-node`, or `source-map-support` dependencies, so they
were removed. None remains in the installed tree. Existing Mocha, NYC, TypeDoc,
generation and packing commands remain in use.
Generated `.tgz` files are excluded from packages so repeated `dist` runs cannot
embed a previous distribution archive.

Normal resolution refreshed Babel core to 7.29.13, Browserslist to 4.29.5,
js-yaml to 3.15.2/5.5.0, diff to 9.0.0, serialize-javascript to 7.1.4,
brace-expansion to 5.0.13 and tar to 7.5.23. NYC's process-info update removes
the old uuid dependency. No overrides are needed for these families. The gRPC,
protobuf and decimal runtime versions remain unchanged; the shared yargs and
escalade runtime transitives received compatible patch/minor refreshes.

Retain these exceptions until their upstream constraints are corrected:

| Override | Upstream constraint and reason | Qualification and removal condition |
| --- | --- | --- |
| `grpc_tools_node_protoc_ts` → `google-protobuf: $google-protobuf` | The generator pins 3.15.8; use the same patched 4.0.3 runtime as production. | Wire/recursion regressions, deterministic generation and strict packed-consumer compilation. Remove when the generator adopts a secure compatible runtime. |
| `grpc_tools_node_protoc_ts` → `handlebars: 4.7.10` | The generator pins 4.7.7. Preserve the previously qualified patched release. | Generated declarations remain byte-for-byte identical. Remove when the generator's own range resolves a patched compatible release. |
| `glob@>=9 <14` → 14.0.6 | Mocha, NYC and test-exclude request 13.x; the [traversal-cancellation advisory](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4) requires at least 14.0.2. | Mocha discovery, recursive/brace patterns, exclusions, NYC async/sync selection and actual coverage pass. Remove when all parents permit a patched release naturally. |
| `minimatch@>=7 <11` → 11.0.8 | Mocha/test-exclude request `^10.2.2`; TypeDoc requests `^10.2.5`. The [pattern-amplification fix](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) needs 11.x. | Mocha exclusions, NYC selection and TypeDoc filtering/rendering pass with the compatibility patch below. Remove when all parents permit a patched release and TypeDoc uses supported APIs. |

The version selectors limit the two matching overrides to the obsolete major
ranges; they do not replace newer compatible versions. Minimatch 11.0.8 also
contains the [escape fix](https://github.com/isaacs/minimatch/security/advisories/GHSA-c859-jr93-m5j4)
and [cache-bounding fix](https://github.com/isaacs/minimatch/security/advisories/GHSA-hqmv-qgp3-jx75)
published on 11 November; 11.0.7 fixes the earlier
[quadratic compile-time regression](https://github.com/isaacs/minimatch/security/advisories/GHSA-cf2h-pxjq-68xw).
These primary advisories were checked separately from scanner output. The
[protobuf recursion advisory](https://github.com/protocolbuffers/protobuf-javascript/security/advisories/GHSA-5h29-r2cp-hfmr)
was also checked explicitly: only google-protobuf 4.0.3 remains, and its runtime
guard is exercised by `test-protobuf`.

**TypeDoc compatibility patch:** a successful install with minimatch 11 initially
failed documentation generation because TypeDoc 0.28.20 calls the removed
`Minimatch.matchOne()` API. `bin/patch-typedoc.js`, run by `prepare`, replaces that
directory-traversal call with a cached matcher using the public partial-matching
API. `flipNegate` preserves the original traversal's matching of pattern rows
before negation. Full-path matching and exclusion options are preserved. The
patch accepts only TypeDoc 0.28.20 and the SHA-256 of its exact published source
(or the complete patched result), is idempotent, and fails on unexpected or partial
changes. This is a local compatibility patch, not an upstream TypeDoc release.
When TypeDoc supports patched minimatch directly, remove this script and its
`prepare` invocation together with the now-unnecessary override; rerun
`test-tooling`, rendering, `dist`, and the packed-consumer checks.

#### Validation on 14 November 2026

Host: macOS arm64; npm 11.20.0. The lockfile remains format 2 and uses public npm
registry URLs. Clean installs used the approved Oracle registry mirror because
direct registry access was blocked by the local corporate network policy.

| Check | Observed result |
| --- | --- |
| Clean `npm ci` | Passed on Node 26.13.1 and 24.13.0; Node 24 also verified automatic application of the TypeDoc patch. Lockfile SHA-256 unchanged by install: `908ca398589e719792eeed4277e5100cdd84ff0816631633a9c22b3837728b63`. |
| `compile` | Passed with TypeScript 6.0.3 and strict checking; all 15 generated/public `.d.ts` files unchanged from the previous baseline. |
| `grpc`, repeated | All 10 generated protobuf artifacts identical across generation runs and to the prior baseline. |
| `test-protobuf` / `test-resolver-unit` | 8 / 27 passing on Node 26; included in the full suites on both tested Node lines. Loopback servers require permission to bind local sockets. |
| `test-tooling` | 3 passing: normal/recursive/brace Mocha discovery and ignore patterns; NYC generated/test/dependency exclusions and async/sync glob results; TypeDoc expanded entry points, generated-code exclusion and additional filters. |
| `npm test` | Node 26: original 254 tests passed; Node 24 after adding tooling regressions: 257 passed. Both used one isolated Coherence 14.1.2-0-3 server. |
| `coverage` | 257 passing on Node 26 against the same server; HTML generated. JSON verification found exactly the 9 original TypeScript source files, valid source line locations and executed statements, with no generated code, tests or dependencies. Statements 88.26%, branches 72.18%, functions 86.56%, lines 88.52%. |
| TypeDoc / `dist` | HTML rendering and package creation passed; 118 HTML pages and 186 package files, with required CommonJS/protobuf/declarations and no nested tarballs or development files. TypeDoc reported 0 errors and 19 warnings about comment tags and cross-references. |
| Packed consumers | Clean JavaScript production install passed; independent review confirmed TypeScript 6.0.3 strict compilation with `@types/node@22.20.5` (see settings and limit below). Both implementation consumers ran protobuf round trips and live map CRUD; TypeScript also checked listener and generated service declarations. No development tools or obsolete protobuf runtime entered the production consumer. |
| Patch integrity | Exact original patched once; reapplication made no write; unexpected source rejected without a write. |
| `npm ls --all` / `git diff --check` | Passed. |
| `npm audit --json` / `npm audit --omit=dev --json` | Both 0 findings at 10:27:57 / 10:27:58 UTC through the approved registry mirror. The service supplies no database timestamp. Complete baseline had 15 findings (2 low, 6 moderate, 7 high); natural updates alone left 8, resolved by the qualified overrides. |
| Trivy 0.76.2, `fs --scanners vuln --include-dev-deps` | 0 findings at 10:27:59 UTC. Database schema 2, updated 2026-11-14 07:01:20 UTC, downloaded 10:14:28 UTC; baseline had 47 package/advisory occurrences. No advisory ignore list or severity filtering was used. |

The independent packed-consumer review used `target: ES2022`, `module: Node16`,
`moduleResolution: Node16`, `strict: true`, `skipLibCheck: false`, and
`esModuleInterop: true`. Compilation passed with `@types/node@22.20.5` under both
TypeScript 6.0.3 and 5.8.3. A fresh production install of the
`@oracle/coherence@1.2.4` tarball selected `@types/node@26.6.6` through protobufjs's
broad dependency. With those typings, both compilers failed with four TS2416 errors
in `lib/util.d.ts`: `HashMap.entries()`, `values()`, `keys()`, and
`[Symbol.iterator]()` return `IterableIterator`, which lacks the `[Symbol.dispose]`
member required by `MapIterator`. This is a pre-existing declaration compatibility
limit, not a step 4 regression. The Node typings are compiler input, separate from
the Node runtime version. The version 22 pin defines the passing review
configuration; it does not fix the iterator incompatibility. That fix is separate
work.

This is bounded development-tool qualification. Node 22, Coherence 22.06.12 and
25.03.2, two-member/foreign-cluster discovery, TLS combinations, Linux and other
architectures were not exercised in this step. The existing Node 22/24/26 and
three-server CI matrices remain unchanged. Scanner results describe the databases
at the recorded times and are supplemented by the primary advisory checks above.

### Code Style
* Currently based on https://google.github.io/styleguide/jsguide#formatting

### FAQ
* Question:  How do I use the library locally in another project for testing purposes?
> Answer: First, run `npm link` within the `coherence-js-client` project to create a global NPM reference.
> then, from the project you want to use the library with, run `npm link @oracle/coherence` which
> will install the library for use with that project
