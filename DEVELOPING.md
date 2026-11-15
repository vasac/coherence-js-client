<!--
Copyright (c) 2020, 2026, Oracle and/or its affiliates.

Licensed under the Universal Permissive License v 1.0 as shown at
https://oss.oracle.com/licenses/upl.
 -->

# Developing Coherence JavaScript Client

### Requirements
* For development and tests, Node `22.12.0` or later in the `22.x` line, `24.x`, or `26.x`; use the latest patch release of a supported line. Mocha 12 needs `require(esm)` support. The published client's runtime floor remains `22.9.0`; development tools are not installed by consumers. Release builds use Node `26.x` LTS.
* npm `11.20.0`, pinned in `package.json` and installed explicitly by CI.
* Docker with Compose for the integration tests. Linux/macOS builds also need `curl`, `tar`, OpenSSL (for local TLS certificates), and network access for dependency installation and the verified JavaScript generator download.

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
* `test-tls` - checks real loopback TLS/gRPC validation, local certificate generation, and test-cycle isolation/cleanup without a Coherence cluster
* `test-resolver-unit` - runs discovery regressions with loopback NameService and gRPC peers; no Coherence cluster is required
* `test-resolver` - runs those regressions and discovery integration tests against local and foreign Coherence clusters
* `test` - runs the unit and integration tests
* `test-cycle` / `test-cycle-tls` - start an isolated two-member cluster, run the unit/integration suite over plaintext / verified TLS, and clean up this invocation's cluster and files
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

`npm exec -- mocha test/hash-map-tests.js` runs the server-free `HashMap` iterator
contracts after compilation. The shared checks in `test/helpers/hash-map-iterators.js`
also run directly against an installed tarball without Mocha, including on the
consumer runtime floor of Node 22.9.0. The TypeScript fixtures in `test/fixtures/`
exercise the packed public API; they must resolve an installed `@oracle/coherence`,
not the repository's source files. See the iterator qualification below.

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

### TLS certificates and verification

Run the focused checks without Docker:

```bash
npm run test-tls
```

This suite generates temporary certificates and starts mutually authenticated
loopback gRPC peers. It checks trusted matching DNS certificates through
`Session`/`NamedCache`, a real Node TLS connection to the IP SAN, trusted but
mismatching server SANs, and untrusted server chains. Rejection assertions require
`UNAVAILABLE` with a certificate-validation cause from a bounded generated-client
RPC on the Session's channel; connection refusal and generic timeouts do not pass.
The peers require the separate trusted client certificate. Tests restore the
opt-out environment immediately after constructing each Session and check that an
opted-out Session does not affect a later verified Session.

Only exact, case-sensitive `COHERENCE_IGNORE_INVALID_CERTS=true` skips hostname
verification. Missing, empty, `false`, `0`, `1`, uppercase variants, surrounding
whitespace, `yes`, and arbitrary values retain verification. The affirmative case
warns and permits a trusted wrong hostname; an untrusted chain still fails even
with that opt-out. This follows [Node's identity callback contract](https://nodejs.org/api/tls.html#tlscheckserveridentityhostname-cert):
the callback runs after other certificate checks. The installed grpc-js 1.14.7
`src/channel-credentials.ts` forwards this callback to `tls.connect` and retains
its authorization check. No global TLS switch or channel hostname override is
needed.

Run the entire existing CRUD, listener, protobuf, session, and other top-level
suites against real Coherence with verification enabled:

```bash
COHERENCE_VERSION=14.1.2-0-3 npm run test-cycle-tls
COHERENCE_VERSION=14.1.2-0-3 npm run test-cycle
```

Use each supported Coherence version and Node line for full matrix qualification.
Set `DOCKER_REGISTRY=container-registry.oracle.com/middleware` to use Oracle's
registry instead of the default `ghcr.io/oracle`. The TLS cycle explicitly removes
any inherited `COHERENCE_IGNORE_INVALID_CERTS`, and the plaintext cycle removes
inherited TLS settings. Both target `localhost:1408`, create unique Compose
projects, and leave the caller's environment, existing certificate directories,
and `etc/jvm-args.txt` intact. They still require the Compose file's published host
ports to be free; an occupied port fails startup and only the newly created
project is stopped. Run cycles sequentially.

Each cycle creates an owner-only temporary directory under
`/private/tmp/codex-work` on macOS or `${TMPDIR:-/tmp}/codex-work` on Linux. It
mounts only the JVM arguments file and the server identity/trust directory
read-only (the CA signing key and client key are outside both mounts). Containers run as the host's numeric UID/GID, with an explicit unique
cluster name, so private keys need no world-readable/writable permissions. EXIT,
INT, and TERM traps tear down only this project and remove its temporary files,
including after compilation, startup, or test failures. New test fixtures also
live under this directory so a forced Mocha deadline cannot leave their keys
behind. Startup has a bounded
readiness wait and detects exited containers; the test process has a three-minute
overall deadline supplied by Node (GNU `timeout` is not required). Failed cycles
retain server diagnostics in `logs-<mode>-test-<version>-<node-version>.txt` in the
repository root, without copying private keys. The focused script tests exercise
success, compile failure, partial startup failure, and suite failure with mock
commands, checking cleanup and configuration preservation. Cancellation checks
send INT/TERM to the cycle PID during compilation, startup, and testing, including
a TERM-resistant descendant. Commands run in separate process groups; cleanup
sends TERM, allows two seconds to stop, then sends KILL and waits for the command
before removing this cycle's resources.

For manual TLS development, generate into a **new** directory; `keys.sh` refuses
existing destinations rather than overwriting certificates:

```bash
bin/keys.sh etc/cert
cp etc/jvm-args-tls.txt etc/jvm-args.txt
export COHERENCE_TLS_CERTS_PATH="$PWD/etc/cert/ca.crt"
export COHERENCE_TLS_CLIENT_CERT="$PWD/etc/cert/client.crt"
export COHERENCE_TLS_CLIENT_KEY="$PWD/etc/cert/client.pem"
export COHERENCE_SERVER_ADDRESS=localhost:1408
unset COHERENCE_IGNORE_INVALID_CERTS
# Match the image registry/version for both coh-up and coh-down.
COHERENCE_VERSION=14.1.2-0-3 npm run coh-up
npm test
COHERENCE_VERSION=14.1.2-0-3 npm run coh-down
```

The manual commands intentionally change your local JVM configuration and leave
certificates for reuse. Afterwards restore your prior JVM arguments/environment
and remove only the certificates you generated when finished. `etc/cert` and
`etc/jvm-args.txt` are ignored by Git and excluded from npm packages.

Generated fixtures expire after 30 days and use SHA-256 signatures with RSA-2048
keys. The self-signed CA has critical `CA:true,pathlen:0` and certificate-signing
key usage. Both leaves have critical `CA:false`, digital-signature/key-encipherment
usage, and distinct keys/subjects. `server/server.crt` has only `serverAuth` EKU and
SANs **DNS:localhost, IP:127.0.0.1**; `client.crt` has only `clientAuth` EKU. Leaf
private keys (`server/server.pem`, `client.pem`) are unencrypted PKCS#8 PEM for
Netty/grpc-js compatibility. `keys.sh` creates directories with mode 700 and
files with mode 600.
`ca.key` stays outside the server mount with the client key; it is a local test
signing key, never a committed fixture. The server mount contains only
`server.pem`, `server.crt`, and `ca.crt`. These fixtures are for local testing.

**Current IP-literal limitation:** grpc-js 1.14.7 sets the TLS `servername` to the
channel target even when it is an IP. Node 26 rejects that SNI value with
`ERR_INVALID_ARG_VALUE`; see [DEP0123](https://nodejs.org/api/deprecations.html#dep0123-setting-the-tls-servername-to-an-ip-address).
Use a matching DNS target such as `localhost` on Node 26. The focused suite checks
IP-target gRPC on Node 22/24 and validates the IP SAN directly through Node TLS on
all lines, without sending an IP SNI value. This preserves verification and does
not introduce a hidden hostname override. TLS discovery using IP-literal
NameService targets on Node 26 shares this pre-existing transport limitation and
is outside this step's qualification.

#### Local TLS qualification on 14 November 2026

Host: macOS arm64; Docker server: Linux aarch64. These runs used the official
`container-registry.oracle.com/middleware/coherence-ce` images, two-member Compose
clusters, `localhost:1408`, npm 11.20.0, and the existing locked dependency
installation. They did not perform fresh installs or trigger hosted CI.

| Node runtime | Coherence 22.06.12, verified TLS | Coherence 14.1.2-0-3, verified TLS | Coherence 25.03.2, verified TLS |
| --- | --- | --- | --- |
| 22.23.5 | 307 passing | 307 passing | 307 passing |
| 24.13.0 | 307 passing | 307 passing | 307 passing |
| 26.13.1 | 306 passing | 306 passing | 306 passing |

Each run included the existing CRUD, listener/protobuf, HashMap, session, resolver
unit, and tooling suites plus the new TLS and cleanup regressions. The count
difference is the IP-target gRPC positive control on Node 22/24; Node 26 uses the
verified DNS control and direct Node TLS IP control as described above. Every TLS
cycle was launched with an inherited `COHERENCE_IGNORE_INVALID_CERTS=true` to
exercise its removal. Node 22/24 cycles also received invalid inherited client/CA
paths, which the isolated cycle replaced without changing the caller's values.

The plaintext control on Node 26.13.1 with Coherence 14.1.2-0-3 also passed all
306 tests, despite inherited invalid TLS paths and the hostname opt-out. Other
plaintext matrix combinations were not repeated in this step. A final Node 26 /
14.1.2-0-3 TLS rerun passed all 306 tests after narrowing the JVM-file mount and
putting generated test fixtures under the cycle's outer cleanup trap.

Standalone `npm run test-tls` passed 24 checks on Node 22/24 and 23 on Node 26,
without forcing process exit. The Node 24 runs used macOS Bash 3.2.57 and LibreSSL
3.3.6; the other matrix runs used OpenSSL 4.1.0. Shell syntax checks (including
Bash 3.2), ShellCheck, TypeScript compilation, and `git diff --check` passed.

After the cancellation follow-up added four regressions, the Node 26.13.1 focused
suite passed 27 checks and the verified TLS cycle against Coherence 14.1.2-0-3
passed 310 tests under macOS Bash 3.2.57. The nine cycle isolation/cleanup checks
also passed on Node 24.13.0. The matrix above predates those four new checks.

Native Linux/Windows client execution, other patch releases (including the
published Node 22.9.0 runtime floor), the default legacy Coherence 22.06.11 image,
and live foreign-cluster/TLS discovery were not qualified in this step. No CI
trigger, security gate, release-publishing, or dependency policy changes are part
of this implementation.

### Dependency security gates

The **Dependency Security** workflow (`trivy-scan.yml`) runs when a PR is opened,
updated, or reopened, on pushes except `ghpages`, by manual request, and daily at
00:00 UTC. Scheduled scans check for advisories published after the code changed.
The publishing job also invokes the same local action immediately before
`npm publish`, against that job's existing checkout and lockfile. A failed gate
prevents the subsequent publish step through GitHub Actions' default success
condition. The release checkout selection and existing functional/TLS test
matrices are separate concerns; this gate does not change them.

The gate uses npm **11.20.0** and Trivy **0.76.2**, with actions pinned by commit.
`bin/dependency-security.js` runs all three scans, retaining reports even when an
earlier scan fails:

* `npm audit --package-lock-only --json --audit-level=info --include=prod --include=optional --include=peer --omit=dev` checks production dependencies.
* The same npm audit with `--include=dev` instead of `--omit=dev` checks the complete dependency tree, including build tools even with `NODE_ENV=production`.
* `trivy fs --scanners=vuln,secret --include-dev-deps --exit-code=1 --severity=UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --ignore-unfixed=false --format=json --list-all-pkgs --no-progress .` scans the filesystem, including development dependencies, and preserves the previous workflow's default secret scanning.

The policy is **zero unresolved known dependency findings at any severity**.
Findings, scanner/service errors, invalid reports, missing root lockfile coverage,
and changes to the manifests during scanning fail the gate. There are no new
advisory ignores, automatic fixes, or severity exclusions. The scans read the
lockfile without installing or updating dependencies. Existing `npm ci` builds
remain responsible for checking manifest/lockfile consistency and build behavior.
See [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/),
[Trivy's npm coverage](https://trivy.dev/docs/latest/coverage/language/nodejs/#npm),
and [GitHub Actions step conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsif).

Artifacts `dependency-security` and `release-dependency-security` retain the JSON
scan reports, scanner stderr, npm registry/version, Node version, per-command UTC
start/end times and exit status, and SHA-256 hashes of both manifests. The Trivy
version report is captured after scanning to record the database schema and
update/download timestamps when available. npm's advisory service does not expose
a database timestamp. Reports live outside the checkout, so they do not enter the
package or the scan input.

To run locally, install the pinned tools, select a supported Node version, and run
from the repository root (no Coherence server is required):

```bash
node --test test/security-gate-tests.cjs
node bin/dependency-security.js /private/tmp/codex-work/coherence-security-reports
```

The focused regressions use stub scanners and a stub publication command; they
exercise success and failure propagation without contacting a publication
endpoint. Local checks do not establish hosted workflow results. Configuring a
workflow does not make it a required merge check; repository rules/branch
protection must be configured separately. Advisory scans detect known findings
and cannot prove that every possible vulnerability is absent.

#### Local gate verification on 15 November 2026

On macOS arm64 with Node **26.13.1**, npm **11.20.0**, and Trivy **0.76.2**,
the real gate passed using the public npm advisory service and a fresh Trivy DB
download. All scans returned zero findings; no ignores, fixes, or dependency
changes were made.

| Scan | UTC interval | Result |
| --- | --- | --- |
| npm production | 05:34:01–05:34:03 | 0 findings |
| npm full tree, explicitly including development dependencies | 05:34:03–05:34:04 | 0 findings |
| Trivy filesystem, including development dependencies | 05:34:04–05:34:05 | 0 vulnerabilities and 0 secrets; 220 packages, including Mocha 12.0.3 and TypeScript 6.0.3 |

Trivy DB schema **2** was updated at **2026-11-15 01:07:39 UTC** and downloaded at
**05:32:23 UTC**. The lockfile hash remained
`908ca398589e719792eeed4277e5100cdd84ff0816631633a9c22b3837728b63`.
All **17** stub-based gate regressions passed, including publication blocking on
each scanner's findings/service errors, malformed reports, secrets, missing
lockfile coverage, and changed input. JavaScript syntax checks, actionlint **1.7.12**,
composite-action YAML parsing, release-step ordering/preservation checks, and
`git diff --check` passed. These were local checks; no hosted workflow or
publication was triggered.

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
member required by `MapIterator`. This was a pre-existing declaration compatibility
limit, not a step 4 regression. The Node typings are compiler input, separate from
the Node runtime version. The version 22 pin defines the passing review
configuration; it does not fix the iterator incompatibility. That fix is separate
from step 4 and is qualified below.

This is bounded development-tool qualification. Node 22, Coherence 22.06.12 and
25.03.2, two-member/foreign-cluster discovery, TLS combinations, Linux and other
architectures were not exercised in this step. The existing Node 22/24/26 and
three-server CI matrices remain unchanged. Scanner results describe the databases
at the recorded times and are supplemented by the primary advisory checks above.

### HashMap iterator compatibility follow-up — 14 November 2026

Before this fix, a newly packed distribution from the step 4 baseline reproduced
the four `lib/util.d.ts` TS2416 errors above with exact `@types/node@26.6.6` under
both TypeScript 6.0.3 and 5.8.3. Both compilers passed with exact
`@types/node@22.20.5`. The additional consumer assignments of `HashMap` to `Map`
and of its iterators to `MapIterator` also failed with the newer typings.

`HashMap.entries()`, `keys()`, `values()` and `[Symbol.iterator]()` now return
`MapIterator<T>`. Their private implementations share a native `Iterator` base,
so the declaration also has real iterator helper methods behind it. Node 22
[introduced iterator helpers](https://nodejs.org/en/blog/announcements/v22-release-announce#v8-update-to-124);
the actual base constructor and helper behavior were verified on Node 22.9.0.
The source compiler explicitly loads `es2025.iterator` and `esnext.disposable`
to check these contracts even when building with the pinned Node 22 typings.
The emitted target remains ES2015/CommonJS; consumers need no polyfill or new
dependency, and the existing engine ranges are unchanged.

The shared `[Symbol.dispose]()` implementation follows
[the ECMAScript iterator disposal algorithm](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-iterator.prototype-%symbol.dispose%):
call `return()` with no arguments if present, propagate its errors, and return
`undefined`. These in-memory iterators normally have no `return()` and hold no
external resource, so repeated disposal does nothing, leaves the map intact and
allows iteration to continue, like a native map iterator. This method is provided
by the client even on Node 22.9.0, where native iterator disposal is absent but
`Symbol.dispose` is available. Exhaustion now returns `{done: true, value: undefined}`
instead of `null`, matching strict built-in iterator return typing. Yielded entries,
keys and values, bucket traversal, independent iterators and resumability after an
early loop exit are preserved. `LocalSet` retains its existing iterator declarations
and uses the corrected shared key iterator at runtime.

#### Packed-consumer qualification

Build host: macOS arm64, Node 26.13.1, npm 11.20.0, TypeScript 6.0.3 and direct
build typings 22.20.5. `npm pack` ran the established `prepack` generation/compile
and `prepare` hooks. The rebuilt tarball was installed separately into two clean
consumer directories with exact typings versions and no dependency overrides.
TypeDoc used a temporary output directory, so these tarballs contain the runtime,
declarations and source, without the generated HTML included by `dist`.
The approved Oracle npm mirror did not resolve during this follow-up, so dependency
installation used cached package data offline. No alternate registry was contacted.
Node 22.9.0 was obtained from the official Node distribution and its archive SHA-256
was checked against the release's `SHASUMS256.txt`.

Both consumers used `target: ES2022`, `module: Node16`, `moduleResolution: Node16`,
`strict: true`, `skipLibCheck: false`, and `esModuleInterop: true`. The primary
`test/fixtures/iterator-consumer.ts` fixture imported the public library, assigned
`HashMap` to `Map`, checked all four iterator types and result narrowing, and used
listeners and generated message/service declarations. Compiler file lists confirmed
that all 12 `.d.ts` files under `lib` were checked. A second compile included
`iterator-disposal-consumer.ts`, which explicitly references `esnext.disposable`
and `esnext.iterator` and checks `using`, disposal and native helper calls.

| Exact Node typings | TypeScript | Primary strict consumer | Disposal/helper consumer |
| --- | --- | --- | --- |
| 22.20.5 | 6.0.3 | Passed | Passed |
| 22.20.5 | 5.8.3 | Passed | Passed |
| 26.6.6 | 6.0.3 | Passed | Passed |
| 26.6.6 | 5.8.3 | Passed | Passed |

For repeat qualification, build a tarball with `npm pack --pack-destination <dir>`,
install it into a fresh directory with each exact typings/compiler combination,
copy the fixtures there, and run `tsc -p <consumer-config>`. Compile the primary
fixture alone first, then both fixtures together so the optional library references
do not mask the primary consumer's default library configuration. Run the emitted
CommonJS files on the supported runtimes too. The consumer must use the tarball
installation, with no link to repository `lib` or `node_modules`.

| Additional check | Observed result |
| --- | --- |
| Packed CommonJS runtime contracts | All 26 shared iterator checks passed in **each** clean consumer on Node **22.9.0**, **24.13.0** and **26.13.1**. Covered all four factories, falsy values, empty/colliding/separate buckets, exhaustion, object identity, live updates, map conversion/`forEach`, independent iterators, early exit, disposal before/during/after traversal, optional `return()` delegation/errors, native helpers and synchronous/asynchronous `LocalSet` traversal. |
| Emitted TypeScript consumers | The primary fixture and the disposal/helper fixture emitted by **both compilers**, with **both typings versions**, ran successfully on all three runtimes above. This includes actual `using` cleanup on Node 22.9.0. |
| Server-free regressions | **48 passed**: 26 new iterator contracts, 8 protobuf checks, 3 tooling checks and 11 request-factory checks. Existing loopback resolver regressions: **27 passed**. |
| Generation / declaration comparison | Generated protobuf artifacts unchanged from the pre-fix snapshot. Of the shipped declarations, only `lib/util.d.ts` changed: the four iterator return annotations. Private iterator classes do not enter that declaration. |
| TypeDoc / packaging | TypeDoc passed with 0 errors and the same 19 existing warnings. Before/after tarballs each contained 59 files with identical paths. Content changes were confined to `src/util.ts`, emitted `lib/util.js`, its source map, `lib/util.d.ts` and its declaration map. |
| Dependency / diff checks | Consumer dependency trees and `git diff --check` passed. No dependency or lockfile changes; the lockfile SHA-256 remains `908ca398589e719792eeed4277e5100cdd84ff0816631633a9c22b3837728b63`. |

This follow-up qualifies iterator behavior and public declarations. It does not
repeat the earlier live Coherence, TLS, multi-member, OS/architecture or security
scanner matrices, and does not qualify compiler versions other than 5.8.3 and
6.0.3. The existing CI matrices and step 4 evidence remain unchanged. Temporary
consumers, archives, downloaded tools and documentation output were removed after
qualification; the fixtures and shared runtime checks remain in the repository.

### Code Style
* Currently based on https://google.github.io/styleguide/jsguide#formatting

### FAQ
* Question:  How do I use the library locally in another project for testing purposes?
> Answer: First, run `npm link` within the `coherence-js-client` project to create a global NPM reference.
> then, from the project you want to use the library with, run `npm link @oracle/coherence` which
> will install the library for use with that project
