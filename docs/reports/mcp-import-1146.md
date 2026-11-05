# MCP import verification report — #1146

## Scope and baseline

This is an incremental follow-up to the merged [#1156](https://github.com/arcships/dim/pull/1156), based on its immutable merge commit `6aa4508fdb88f51b9837a63cfbd8bd42d1c5012c`, for [#1146](https://github.com/arcships/dim/issues/1146). The PR targets `main`. Validation began on `9ec040e` and then `6723886`; the final parent updates were integrated and revalidated before delivery. The increment retains the merged native import owner, standard-JSON RPCs and CLI. Foreign-format conversion and explicit file/folder discovery belong to the Web file boundary; there is no native `format` parameter, second persistence path, background scan or synchronization.

The earlier standalone implementation and its results are **not** evidence for this increment. Every runtime scenario below used the integrated production App Server and Web build, disposable configuration/workspaces and synthetic credentials. No personal Dim home or real client configuration was imported.

## Environment

| Component | Observed version / setup |
| --- | --- |
| Host | macOS 27.2, arm64 |
| Rust / Cargo | 1.98.1 / 1.98.1 |
| Native product | `0.1.0-alpha.18`, protocol 3 |
| Web / ordinary checks | Node 24.21.0, locked dependencies including `smol-toml` 1.9.1 |
| System-runtime acquisition / SDK checks | Standard bundled Node 24.22.1, Python 3.12.13, rutis 0.19.3; empty npm user/global configuration |
| Browser | Real Chromium; production Vite assets served by the native `web.open` entry |
| Isolation | Unique temporary homes, workspaces, Unix sockets and loopback ports; native storage; no server enabled by import |

The system-runtime checks require Node's own bundled npm and Python 3.12+ on `PATH`. A pnpm-installed Node binary without the conventional npm layout and system Python 3.9 do not meet that contract. Correcting this verification environment required no product changes.

## Executed checks

| Check | Observed result |
| --- | --- |
| `cargo fmt --all` and workspace Clippy with `-D warnings` | Passed |
| `cargo build --workspace --all-targets --locked` | Passed; test executable paths recorded once per integrated build |
| Complete merged-parent workspace, four threads per binary | **2,807 passed, 0 failed, 95 default-ignored**, across 115 binaries on `6aa4508` plus this increment |
| Workspace doctests | 5 passed across 17 suites |
| `xtask graph` then `xtask check` | Passed; generated inventory updated by the generator, not hand-edited |
| Production CLI ignored group | 18 passed; the three affected MCP/ACP cases also passed again on the final latest-base owner |
| Node/Python transport ignored group | **70 passed, 0 failed** in one final merged-parent run using the corrected isolated runtime environment |
| Real MCP SDK transport group | 4 passed |
| Public plugin SDK checks | 2 passed after correcting the bundled-Node environment |
| Workflow plugin TypeScript check | Passed |
| Complete Web behavior suite | **168 passed, 0 failed, 0 skipped**, including the OMP field-boundary conformance fixtures |
| Web typecheck and production Vite build | Passed after the final modal correction |
| ADR freeze check against the pinned parent | Passed; no accepted ADR changed |
| Independent merged-parent native checks | **23/23** focused import/safety cases and **26/26** MCP service/publication cases passed; broader unchanged MCP paths also passed in the full workspace |
| Independent latest-base IPC replay | All 1,000 invalid long-ID rows returned in an 8,500,099-byte response; no ID repeated in errors, source revision unchanged, connection and follow-up preview usable |

Of the 95 default-ignored tests, the 92 production CLI / Node / Python / MCP SDK
cases above were executed in their dedicated groups. Three unrelated opt-in cases
remain outside this feature's acceptance: wall-clock execution handoff, a credential
lookup timing benchmark, and live Context7 access requiring a real API key. No
external credential was requested or used. Zero-match selectors are not counted.

### Failures found and resolved

- Two older native tests assumed raw project-file tokens (`missing` or a token
  retained after overlay cleanup). They now consume the owner's complete snapshot
  token; all original persistence/recovery assertions remain. The final complete
  workspace run has zero failures.
- Two Web tests treated static `disabled=""` as different from a disabled control.
  The synthetic renderer now models native Boolean-attribute semantics; the
  assertions remain, and the actual browser also verified invalid rows are disabled.
- Seven language-runtime failures were verification-environment errors: an incorrect
  venv directory name, Node without its bundled npm, and Python 3.9 on the system
  path. Corrected prerequisites made those seven tests pass without product edits.
- A merged-parent lifecycle test depended on transient diagnostic text naming an
  internal fixture. Its checks now use the public `AgentError::Build` and
  `AgentError::Framework` categories, retaining both rejection and empty Session
  registry assertions, the original timeout and cleanup. The 20-case target and
  the complete workspace passed afterward; no runtime failure was suppressed.
- The modal session-format regression failed before the reset and passed afterward.
- Independent native IPC reproduced the old preview-frame bug: an 8,351,016-byte
  document containing 1,000 invalid 8,345-character IDs closed the connection.
  A temporary reply-budget guard first made it return a safe error. Upstream then
  fixed the root cause by reporting each variable-length name/id only once. This
  increment adopts that fix and its long-name/id regressions, and removes the
  redundant serializer pass and rejection test. Large accepted documents now retain
  their preview rather than being rejected solely because diagnostic metadata repeats.
- The final merged parent's extension-only and OAuth-extension comparisons were
  retained. Its stale-import warning was ported into the new dialog and observed
  against a real concurrent native write: no selected entry was imported, the
  warning says a replacement target may now be disabled, and re-preview is required.

## Issue acceptance

| Requirement | Observed evidence |
| --- | --- |
| Select and preview a multi-entry MCP document without execution/contact | Real browser file upload → native preview; command marker absent and HTTP sentinel received zero requests |
| Show identity, transport, source/client, destination, validation and same-ID conflicts without values | Mixed valid/conflicting/invalid source rendered metadata only; fixture bearer/header/env/argument values absent from the dialog |
| Import only selected entries after explicit confirmation | Rows initially unselected; final confirmation separate from preview; selected HTTP entry and renamed collision written, unselected/invalid entries absent |
| Preserve compatible fields and references; report unsupported formats/semantics | Nine-format matrix below; persisted native values inspected; malformed/unsupported cases covered by adapter and modal behavior suites |
| Leave source files and unrelated Dim entries unchanged | Source SHA-256 checks unchanged; collision rename retained the original definition; skipped entries were not written |
| Keep project imports disabled and secrets user-local | Public skeletons omit hidden values and enablement; full values/references remain in the user-local overlay; real active-session partial-write scenario stayed disabled |
| Re-import/rescan without duplicates; show changes/conflicts | Identical import returned `unchanged 1` with unchanged source token; actual on-disk replacement plus explicit file reacquisition changed preview; stale target apply was refused and required new selections |
| Distinguish no candidates, unreadable input, malformed/local-invalid entries and an empty catalog | Component behavior tests exercise each state; real directory-boundary selection and mixed native-invalid preview exercise the integrated path |

### Client-to-native matrix

Each row was imported through the actual browser and unchanged native preview/apply RPCs in **both user and project scope**. All resulting entries were disabled. Source files remained unchanged, and no fixture command or HTTP endpoint was invoked.

| Explicit format | Conversion / persistence observed |
| --- | --- |
| Standard JSON / compatible Claude documents | Original `mcpServers` document reaches the native decoder; command/args/env retained |
| Codex TOML | `mcp_servers`; `1.001` tool-timeout seconds persisted as `1001` milliseconds |
| OMP JSON | Compatible stdio fields and literal environment values retained; incompatible indirection/request timeout has explicit local rejection coverage |
| Qoder JSON | Compatible stdio definition and `disabled` translation; final imported entry still disabled |
| Kimi Code JSON | URL defaults to HTTP; bearer-variable reference persisted as `${DIM_SMOKE_KIMI_TOKEN}` |
| Cursor JSON | URL-only HTTP; `${env:NAME}` converted to literal native `${NAME}` without expansion |
| Gemini CLI JSON | `url` mapped to SSE; percent-encoded URL preserved, not mistaken for Windows environment expansion |
| VS Code JSON | `servers` root converted; header environment references preserved |
| OpenCode JSON | Local command array split into command/args; environment and `{env:NAME}` references converted |

Strict JSON parsing is intentional: discovered OpenCode `.jsonc` files are identified as that client but JSONC input is explicitly rejected. Unsupported auth helpers, input/file expansion, incompatible timeouts and other unsupported foreign semantics are not silently imported. Compatible neighboring entries remain selectable.

## Real-surface scenarios

1. **Conflict / subset / confirmation:** a source with a same-ID entry, a new HTTP entry, an unselected stdio entry and an invalid entry produced `imported 1, renamed 1, skipped 2`. Existing configuration stayed intact.
2. **Stale target:** an independent owner write after preview caused apply to return a settings conflict without writing selected targets. Refresh cleared selections; explicit reselection and rename then succeeded.
3. **Real partial persistence failure:** with an active production session, a temporary SQLite trigger rejected the `user/mcp-secrets` update after the project skeleton commit. The UI reported accepted target IDs **needing review**, not fabricated completed groups. The entry remained disabled. Removing the test trigger, refreshing and explicitly replacing recovered successfully. The trigger was removed before restart.
4. **Full process restart:** after cleanly stopping and starting the native daemon on the same store, the effective catalog matched, all entries remained disabled, both native MCP documents were byte-for-byte unchanged, and the project file was unchanged. The command marker and HTTP sentinel still showed no execution/contact.
5. **Actual file reacquisition:** overwriting a selected disk file did not change the retained preview. Explicitly selecting the file again changed the preview from the old to the new entry.
6. **Opt-in discovery:** a browser `FileList` containing nine recognized client paths and one unrelated file produced exactly nine labelled candidates. Choosing Qoder used the same real preview flow. No files were read merely by opening the dialog.
7. **Keyboard/lifecycle:** Enter in the rename field did not submit the parent form; the next step focused the dialog heading; Done restored opener focus; Escape dismissed; cancelling the intercepted native file chooser kept the dialog open. Following a real daemon shutdown, offline Cancel remained usable outside the disabled settings form.
8. **Layout/accessibility:** desktop 1440×1000 and narrow 390×844 in light/dark themes, 720×500 zoom-equivalent layout, reduced motion, native font size 18 and Chinese labels. Geometry checks found no horizontal overflow; header/footer remained visible and content scrolled. Native Geist typography/tokens and the 640px desktop dialog were retained.

### Browser automation boundary

Regular file uploads and on-disk file reacquisition used real Chromium file inputs. Native file-picker cancellation was exercised separately. Headless CDP directory-path upload emitted no change event, so discovery was exercised using main-world browser `File`/`FileList` objects with the actual relative-path contract. This proves the application's directory-input boundary and downstream behavior; it is **not** evidence for an OS folder permission dialog. No native RPC success was mocked in these real-surface scenarios.

## Safety regressions and review dispositions

| Defect / invariant | Correction and regression |
| --- | --- |
| Import mutation lifetime could outlive a caller-local ordering guard | One owner-tracked gate covers updates, moves, imports and conditional overlay cleanup; controlled caller-disconnect/cancellation/owner-close cases |
| Project file revision alone does not identify changed hidden credentials | Opaque current/applied project tokens bind the file and overlay; every ordinary project mutation checks the complete token |
| Retained live generation could survive an incompatible replacement plus failed overlay write | Withdraw and settle old generations before writing replacement skeletons; controlled real HTTP retirement/overlay-failure scenario |
| An orphan overlay could be absorbed or destroyed implicitly | Orphan IDs reserve import/rename destinations; only explicit Replace may replace that record |
| Unreadable enablement could default to empty and bypass withdrawal | Adopt upstream's unconditional withdrawal and retain an unreadable-state regression proving refusal before source/overlay writes and preservation of the old definition |
| Overlay-only changes could retain an old application failure | Failure retention and applied-state publication use the effective project token; both controlled creation-failure paths covered without reacquiring |
| Count-capped diagnostics could still overflow the 16 MiB reply frame | Adopt upstream's disjoint field-name lists and non-repeated error IDs, with near-limit long-name/id success regressions; remove the redundant local byte-budget layer |
| A previous dialog's adapter could affect a new arbitrary file | New dialog sessions reset to JSON; regression failed before the change and passed afterward |
| Existing CLI readiness test could match the command menu before session switch | Wait for the committed `new session` boundary; full workspace execution covered the actual PTY flow |

The source-CAS-after-withdrawal case is intentionally fail-closed: an external edit after the initial token check may leave the old project entry disabled even when the source write loses CAS. It never restores a stale enablement choice. A controlled lease/event regression preserves the external edit and old overlay while asserting disabled state. In contrast, a queued request rejected by the owner gate's initial stale-token check changes nothing and leaves its target's enablement intact. The inherited concurrent-import test was migrated to that early-rejection contract; the deterministic external-CAS test separately covers the later phase.

Variant checks covered ordinary mutation entrypoints, both application-failure insertion paths and retention, orphan import/rename/replace cases, source/overlay token consumers, native preview serialization and the sole client-format dialog. Read-only enablement fallback is not used to authorize import writes. The existing session-key reply byte guard is a separate already-bounded path.

## Independent review

- **Native static review:** all original findings and the latest-base integration
  closed. The upstream deduplication root fix replaces the redundant extra guard;
  early stale-token refusal and late source-CAS withdrawal have separate coverage.
- **Web static review:** the cross-session format finding is closed by the reset
  and failed-before/passed-after regression; no additional findings remained.
- **Fresh merged-parent native verifier:** **ACCEPT**, with 23 focused import/safety
  cases, 26 service/publication cases and the actual Unix IPC long-ID replay. The reply
  contained 1,000 distinct invalid rows, repeated no IDs in errors, kept the source
  revision unchanged and left the connection usable.
- **Fresh latest-base Web verifier:** **ACCEPT**, combining the unchanged-format
  journeys with a delta run on the final daemon/assets: deduplicated metadata,
  selected replacement, safe malformed JSON and local-invalid helper diagnostics.
  The final merged-parent stale-warning change also passed a real browser/native
  conflict scenario, and its complete Web suite, typecheck and build passed again.
  An OMP candidate finding was withdrawn against the [primary documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md#pre-connect-envheader-resolution):
  leading `!` is helper syntax only in env/header values; a stdio command name
  beginning `!` remains literal. Conformance fixtures protect that field boundary
  rather than introducing an unsupported restriction.

An auxiliary scalar review of the client adapter boundary returned low-confidence,
generic suggestions rather than a concrete additional defect. It was not an
acceptance gate or a substitute for these checks. Old ratings of the abandoned
implementation were not carried forward; no code was changed merely to improve a
score.

## Screenshots

These are cropped captures of the actual running product with synthetic fixture identities, not the Oil UI prototypes. No bootstrap URL, personal filesystem path or credential is included.

- [Desktop preview](mcp-import-1146/desktop-preview.png)
- [Explicit final confirmation](mcp-import-1146/confirmation.png)
- [Chinese desktop](mcp-import-1146/desktop-chinese.png)
- [Chinese narrow layout, native font size 18](mcp-import-1146/narrow-chinese-large-text.png)

## Reproducing the checks

Use the repository's toolchain and dependency setup, including a standard Node distribution with its bundled npm. Build once with CI settings and run the recorded binaries:

```sh
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 RUSTC_WRAPPER=
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build --workspace --all-targets --locked --message-format=json > target/test-artifacts.jsonl
node scripts/run-rust-test.mjs target/test-artifacts.jsonl --workspace --test-threads=4
cargo test --workspace --doc --locked
target/debug/xtask check
npm ci --prefix web --ignore-scripts --no-audit --no-fund
npm test --prefix web
npm run build --prefix web
node scripts/adr-check.mjs --base 6aa4508fdb88f51b9837a63cfbd8bd42d1c5012c
```

Run the production CLI and Node/Python groups with the environment documented in `.github/workflows/ci.yml` (`DIM_TEST_APP_SERVER`, `DIM_TEST_NPM_WRAPPER`, `DIM_TEST_NODE`, `DIM_TEST_JS_RUNTIME`, `DIM_TEST_RUTIS_SDK`, `DIM_TEST_PYTHON`, `RUTIS_HOST`). The `migration_flow node_ --ignored` selector matches zero tests in this baseline and is not counted as coverage.

For browser verification, launch the production assembly with an isolated home/socket and the offline model fixture:

```sh
target/debug/dim-app-server \
  --model-config crates/dim-agent-aimux/examples/offline.json \
  --home "$TEMP_HOME" --unix "$TEMP_SOCKET" --no-ws \
  --web-assets "$STAGED_WEB"
```

Maintain a local JSON-RPC connection, send `hello` with protocol version 3 and client kind `cli`, then `web.open` with port 0. Keep the returned bootstrap URL private. A mock-only assembly does not install MCP management and is not an equivalent verification surface.
