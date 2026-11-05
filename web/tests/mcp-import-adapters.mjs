import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import test from "node:test"

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".ts")) return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true }
    return next(url, context)
  },
})

const { adaptImportDocument, ImportDocumentError, MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES } = await import("../src/features/settings/mcp-adapters.ts")

function source(format, servers, extra = {}) {
  const key = format === "vscode" ? "servers" : format === "opencode" ? "mcp" : "mcpServers"
  return JSON.stringify({ [key]: servers, ...extra })
}

function converted(format, servers, extra) {
  return adaptImportDocument(source(format, servers, extra), format)
}

const local = { command: "never-execute-import-fixture" }
const remote = { type: "http", url: "https://example.invalid/mcp" }

const conversions = [
  ["omp", {
    local: { ...local, command: "!literal-executable", args: ["fixture-argument", "${ARG:-default}"], env: { TOKEN: "${TOKEN}" }, cwd: "./tools", enabled: true },
    http: { url: "${ENDPOINT}", headers: { Authorization: "Bearer ${TOKEN}" } },
    sse: { type: "sse", url: "https://example.invalid/events", oauth: { clientId: "fixture-client", callbackPort: 9123 } },
  }, {
    local: { ...local, command: "!literal-executable", args: ["fixture-argument", "${ARG:-default}"], env: { TOKEN: "${TOKEN}" }, cwd: "./tools", enabled: true },
    http: { type: "http", url: "${ENDPOINT}", headers: { Authorization: "Bearer ${TOKEN}" } },
    sse: { type: "sse", url: "https://example.invalid/events", oauth: { clientId: "fixture-client", callbackPort: 9123 } },
  }],
  ["qoder", {
    local: { ...local, env: { TOKEN: "literal-fixture-token" }, disabled: false },
    http: { type: "streamable-http", url: "${ENDPOINT}", disabled: true },
    sse: { type: "sse", url: "https://example.invalid/events", headers: { "X-Key": "fixture-header" } },
  }, {
    local: { ...local, env: { TOKEN: "literal-fixture-token" }, enabled: true },
    http: { type: "streamable-http", url: "${ENDPOINT}", enabled: false },
    sse: { type: "sse", url: "https://example.invalid/events", headers: { "X-Key": "fixture-header" } },
  }],
  ["kimi", {
    local: { ...local, args: ["${ARG}"], cwd: "./tools", toolTimeoutMs: 1001 },
    http: { url: "${ENDPOINT}", bearerTokenEnvVar: "DIM_IMPORT_FIXTURE_TOKEN", toolTimeoutMs: 86400000 },
    sse: { transport: "sse", url: "https://example.invalid/events", headers: { "X-Key": "fixture-header" } },
  }, {
    local: { ...local, args: ["${ARG}"], cwd: "./tools", timeout: 1001 },
    http: { type: "http", url: "${ENDPOINT}", auth: { type: "bearer", token: "${DIM_IMPORT_FIXTURE_TOKEN}" }, timeout: 86400000 },
    sse: { type: "sse", url: "https://example.invalid/events", headers: { "X-Key": "fixture-header" } },
  }],
  ["cursor", {
    local: { command: "${env:EXE}", args: ["--token=${env:TOKEN}"], env: { KEY: "${env:KEY}" } },
    http: { url: "${env:ENDPOINT}", headers: { Authorization: "Bearer ${env:TOKEN}" } },
  }, {
    local: { command: "${EXE}", args: ["--token=${TOKEN}"], env: { KEY: "${KEY}" } },
    http: { type: "http", url: "${ENDPOINT}", headers: { Authorization: "Bearer ${TOKEN}" } },
  }],
  ["gemini", {
    local: { ...local, env: { TOKEN: "${TOKEN}", LABEL: "50% 中文 €" }, args: ["%DE%", "50%"] },
    http: { httpUrl: "https://example.invalid/%E2%82%AC/%DE%", headers: { "X-Literal": "%DE%" } },
    sse: { url: "https://example.invalid/events?literal=50%" },
  }, {
    local: { ...local, env: { TOKEN: "${TOKEN}", LABEL: "50% 中文 €" }, args: ["%DE%", "50%"] },
    http: { type: "http", url: "https://example.invalid/%E2%82%AC/%DE%", headers: { "X-Literal": "%DE%" } },
    sse: { type: "sse", url: "https://example.invalid/events?literal=50%" },
  }],
  ["vscode", {
    local: { type: "stdio", ...local, env: { TOKEN: "${env:TOKEN}" }, args: ["${env:ARG}"] },
    http: { ...remote, headers: { "X-Key": "${env:TOKEN}" } },
  }, {
    local: { type: "stdio", ...local, env: { TOKEN: "${TOKEN}" }, args: ["${ARG}"] },
    http: { ...remote, headers: { "X-Key": "${TOKEN}" } },
  }],
  ["opencode", {
    local: { type: "local", command: ["never-execute-import-fixture", "{env:ARG}"], environment: { TOKEN: "{env:TOKEN}" }, cwd: "./tools", enabled: true },
    http: { type: "remote", url: "{env:ENDPOINT}", headers: { Authorization: "Bearer {env:TOKEN}" } },
  }, {
    local: { type: "stdio", ...local, args: ["${ARG}"], env: { TOKEN: "${TOKEN}" }, cwd: "./tools", enabled: true },
    http: { type: "http", url: "${ENDPOINT}", headers: { Authorization: "Bearer ${TOKEN}" } },
  }],
]

for (const [format, input, expected] of conversions) {
  test(`${format} converts external configuration to the inherited native document shape`, () => {
    const result = converted(format, input)
    assert.deepEqual(JSON.parse(result.document), { mcpServers: expected })
    assert.deepEqual(result.invalid, [])
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(Object.keys(result), ["document", "invalid", "warnings"])
  })
}

test("standard JSON remains byte-for-byte native input, including malformed documents and unknown fields", () => {
  for (const text of [
    "not valid JSON", "{}", "{\"mcpServers\":{\"a\":null}}",
    ' { "mcpServers": { "a": {"command":"exe","unknown":"fixture-secret"} }, "inputs": [] }\n',
    '{"mcpServers":{"a":{"command":"first"},"a":{"command":"last"}}}',
  ]) {
    assert.deepEqual(adaptImportDocument(text, "json"), { document: text, invalid: [], warnings: [] })
  }
})

test("Codex TOML documents preserve credentials and references without resolving them", () => {
  const text = `
model = "private-model-fixture"
[mcp_servers.local]
command = "never-execute-import-fixture"
args = ["fixture-argument", "\${ARG}"]
cwd = "./tools"
enabled = true
tool_timeout_sec = 1.001
env = { TOKEN = "\${TOKEN:-fixture-default}" }
[mcp_servers.remote]
url = "https://example.invalid/mcp?token=fixture-query"
http_headers = { "X-Static" = "fixture-header" }
env_http_headers = { "X-Key" = "TOKEN" }
bearer_token_env_var = "BEARER_TOKEN"
tool_timeout_sec = 86400
[mcp_servers."quoted.name"]
command = "never-execute-import-fixture"
args = [
  "Unicode 中文 €",
  "multiline array",
]
`
  const result = adaptImportDocument(text, "codex")
  assert.deepEqual(JSON.parse(result.document), { mcpServers: {
    local: { ...local, args: ["fixture-argument", "${ARG}"], cwd: "./tools", enabled: true, timeout: 1001, env: { TOKEN: "${TOKEN:-fixture-default}" } },
    remote: { type: "http", url: "https://example.invalid/mcp?token=fixture-query", headers: { "X-Static": "fixture-header", "X-Key": "${TOKEN}" }, auth: { type: "bearer", token: "${BEARER_TOKEN}" }, timeout: 86400000 },
    "quoted.name": { ...local, args: ["Unicode 中文 €", "multiline array"] },
  } })
  assert.deepEqual(result.invalid, [])
  assert.deepEqual(result.warnings, ["Unrelated client settings are not imported."])
  assert.ok(!result.document.includes("private-model-fixture"))
})

const unsupported = [
  ["omp", [
    { ...local, timeout: 10000 }, { ...local, timeout: 0 },
    { ...local, env: { TOKEN: "!printf private-fixture-token" } },
    { ...remote, headers: { "X-Key": "PRIVATE_FIXTURE_TOKEN" } },
    { ...remote, headers: { Authorization: "!printf private-fixture-token" } },
    { ...remote, auth: { type: "oauth", credentialId: "private-fixture-credential" } },
    { ...remote, oauth: { clientSecret: "private-fixture-secret" } },
    { ...remote, oauth: { clientId: "${PRIVATE_FIXTURE_CLIENT}" } },
    { ...local, requestIdFormat: "string" }, { ...local, instructions: false },
  ]],
  ["qoder", [
    { qoder_url: "https://example.invalid/private-fixture-gateway" }, { ...local, timeout: 10000 },
    { ...local, trust: true }, { ...local, includeTools: ["private-fixture-tool"] },
    { ...local, excludeTools: ["private-fixture-tool"] }, { ...local, alwaysAllow: ["private-fixture-tool"] },
    { ...remote, oauth: { tokenUrl: "private-fixture-endpoint" } },
    { ...local, disabled: "private-fixture-disabled" }, { ...local, disabled: false, enabled: true },
  ]],
  ["kimi", [
    { ...local, environment_id: "private-fixture-remote" }, { ...local, deferred: false },
    { ...local, startupTimeoutMs: 30000 }, { ...local, enabledTools: ["private-fixture-tool"] },
    { ...local, disabledTools: ["private-fixture-tool"] },
    { url: "https://example.invalid/mcp", bearerTokenEnvVar: "private-fixture invalid name" },
    { url: "https://example.invalid/mcp", bearerTokenEnvVar: "TOKEN", headers: { aUtHoRiZaTiOn: "private-fixture-auth" } },
    { ...remote, transport: "sse" }, { ...local, timeout: 1000, toolTimeoutMs: 1000 },
  ]],
  ["cursor", [
    { ...local, args: ["${workspaceFolder}/private-fixture-path"] },
    { url: "https://example.invalid/mcp", headers: { "X-Key": "${input:private-fixture-input}" } },
    { ...local, envFile: "private-fixture-envfile" },
    { url: "https://example.invalid/mcp", auth: { CLIENT_ID: "private-fixture-client" } },
    { ...local, futureCredentialHelper: "private-fixture-helper" },
  ]],
  ["gemini", [
    { ...local, env: { TOKEN: "%DE%" } }, { ...local, env: { TOKEN: "$PRIVATE_FIXTURE_TOKEN" } },
    { ...local, env: { TOKEN: "$(private-fixture-helper)" } }, { ...local, timeout: 10000 },
    { ...local, trust: false }, { ...local, includeTools: ["private-fixture-tool"] },
    { ...local, excludeTools: ["private-fixture-tool"] },
    { httpUrl: "https://example.invalid/mcp", authProviderType: "private-fixture-provider" },
    { url: "https://example.invalid/events", httpUrl: "https://example.invalid/mcp" },
  ]],
  ["vscode", [
    { ...local, args: ["${input:private-fixture-input}"] }, { ...local, envFile: "private-fixture-envfile" },
    { ...local, sandbox: { enabled: true } }, { command: "${workspaceFolder}/private-fixture-exe" },
    { ...local, inputs: ["private-fixture-input"] },
  ]],
  ["opencode", [
    { type: "remote", url: remote.url, oauth: false }, { type: "local", command: [local.command], timeout: 10000 },
    { type: "remote", url: remote.url, headers: { "X-Key": "{file:private-fixture-file}" } },
    { type: "local", command: [] }, { type: "local", command: ["private-fixture-exe", false] },
    { type: "local", command: [local.command], args: ["private-fixture-argument"] },
    { type: "remote", url: remote.url, environment: { TOKEN: "private-fixture-token" } },
  ]],
]

for (const [format, entries] of unsupported) {
  test(`${format} rejects incompatible semantics locally without dropping valid neighbors or exposing values`, () => {
    const good = format === "opencode" ? { type: "local", command: [local.command] } : local
    const servers = Object.fromEntries(entries.map((entry, index) => [`bad-${index}`, entry]))
    servers.good = good
    const result = converted(format, servers)
    assert.equal(result.invalid.length, entries.length)
    assert.deepEqual(Object.keys(JSON.parse(result.document).mcpServers), ["good"])
    assert.deepEqual(result.invalid.map((issue) => issue.id), entries.map((_, index) => `bad-${index}`))
    assert.ok(result.invalid.every((issue) => issue.fields.length && issue.message.length))
    assert.ok(!JSON.stringify(result.invalid).includes("private-fixture"))
    assert.ok(!JSON.stringify(result.invalid).includes("PRIVATE_FIXTURE"))
    const allInvalid = converted(format, Object.fromEntries(entries.map((entry, index) => [`bad-${index}`, entry])))
    assert.deepEqual(JSON.parse(allInvalid.document), { mcpServers: {} })
    assert.equal(allInvalid.invalid.length, entries.length, "an all-invalid source must remain visibly rejected")
  })
}

test("Codex rejects helpers, credentials, ambiguous headers and non-JSON TOML values per entry", () => {
  const cases = [
    "command='exe'\nstartup_timeout_sec=10", "command='exe'\nenabled_tools=['private-fixture-tool']",
    "command='exe'\nenv_vars=['private-fixture-env']", "url='https://example.invalid/mcp'\nauth={command='private-fixture-helper'}",
    "url='https://example.invalid/mcp'\nenv_http_headers={KEY='private-fixture invalid name'}",
    "url='https://example.invalid/mcp'\nhttp_headers={KEY='private-fixture-header'}\nenv_http_headers={key='TOKEN'}",
    "url='https://example.invalid/mcp'\nhttp_headers={KEY='private-fixture-header',key='other'}",
    "url='https://example.invalid/mcp'\nhttp_headers={aUtHoRiZaTiOn='private-fixture-auth'}\nbearer_token_env_var='TOKEN'",
    "url='https://example.invalid/mcp'\nbearer_token_env_var='private-fixture invalid name'",
    "command='exe'\ntool_timeout_sec=nan", "command='exe'\ntool_timeout_sec=inf", "command=2026-11-05",
    "command='exe'\ntool_timeout_sec=1.0001", "command='exe'\ntool_timeout_sec=-1",
    "command='exe'\ntool_timeout_sec=9223372036854775807",
  ]
  const text = cases.map((fields, index) => `[mcp_servers.bad-${index}]\n${fields}\n`).join("") + `[mcp_servers.good]\ncommand='${local.command}'`
  const result = adaptImportDocument(text, "codex")
  assert.equal(result.invalid.length, cases.length)
  assert.deepEqual(JSON.parse(result.document), { mcpServers: { good: local } })
  assert.ok(!JSON.stringify(result.invalid).includes("private-fixture"))
})

test("native type, transport and supported timeout range validation stay with the inherited decoder", () => {
  const cases = [
    ["omp", { scalar: "private-fixture-scalar", null: null, broken: { command: 5 }, env: { ...local, env: { TOKEN: null } }, transport: { ...remote, command: "exe" } }],
    ["kimi", { remoteEnv: { url: remote.url, env: { TOKEN: "private-fixture-token" } }, timeout: { ...local, toolTimeoutMs: 999 } }],
  ]
  for (const [format, entries] of cases) {
    const result = converted(format, entries)
    assert.deepEqual(result.invalid, [])
    const native = JSON.parse(result.document).mcpServers
    assert.deepEqual(Object.keys(native), Object.keys(entries))
    if (format === "omp") assert.deepEqual(native, entries)
    if (format === "kimi") {
      assert.equal(native.timeout.timeout, 999)
      assert.deepEqual(native.remoteEnv.env, entries.remoteEnv.env)
    }
  }
  for (const [seconds, millis] of [[1, 1000], [1.001, 1001], [86400, 86400000], [0.999, 999], [86400.001, 86400001]]) {
    const result = adaptImportDocument(`[mcp_servers.a]\ncommand='exe'\ntool_timeout_sec=${seconds}`, "codex")
    assert.deepEqual(result.invalid, [])
    assert.equal(JSON.parse(result.document).mcpServers.a.timeout, millis)
  }
})

test("Gemini percent expansion is field-aware, preserving URL encoding, headers, arguments and Unicode", () => {
  const result = converted("gemini", {
    encoded: { httpUrl: "https://example.invalid/%E2%82%AC?value=%DE%", headers: { literal: "%DE%" } },
    literal: { ...local, args: ["%DE%", "50%", "中文 €"], env: { amount: "50% 中文 €" } },
    windows: { ...local, env: { token: "%DE%" } },
  })
  assert.deepEqual(result.invalid.map((issue) => issue.id), ["windows"])
  const native = JSON.parse(result.document).mcpServers
  assert.equal(native.encoded.url, "https://example.invalid/%E2%82%AC?value=%DE%")
  assert.equal(native.encoded.headers.literal, "%DE%")
  assert.deepEqual(native.literal.args, ["%DE%", "50%", "中文 €"])
  assert.equal(native.literal.env.amount, "50% 中文 €")
})

test("unsupported field keys and discarded top-level values never enter diagnostics or native content", () => {
  for (const format of ["omp", "qoder", "kimi", "cursor", "gemini", "vscode", "opencode"]) {
    const base = format === "opencode" ? { type: "local", command: [local.command] } : local
    const result = converted(format, {
      bad: { ...base, "https://private-fixture-token@example.invalid/key": "private-fixture-value" },
      oauth: { ...remote, oauth: { "private-fixture-secret-shaped-key": "private-fixture-value" } },
      good: base,
    }, { "private-fixture-root-key": { token: "private-fixture-root-value" } })
    const diagnostics = JSON.stringify({ invalid: result.invalid, warnings: result.warnings })
    assert.ok(!diagnostics.includes("private-fixture"), diagnostics)
    assert.deepEqual(Object.keys(JSON.parse(result.document).mcpServers), ["good"])
    assert.ok(!result.document.includes("private-fixture"))
    assert.deepEqual(result.warnings, ["Unrelated client settings are not imported."])
  }
})

test("prototype-shaped ids and map keys remain data without prototype pollution", () => {
  for (const format of ["omp", "qoder", "kimi", "cursor", "gemini", "vscode"]) {
    const text = source(format, JSON.parse('{"__proto__":{"command":"exe"},"constructor":{"command":"exe"},"normal":{"command":"exe","env":{"__proto__":"fixture-literal-token"}}}'))
    const result = adaptImportDocument(text, format)
    assert.deepEqual(result.invalid, [])
    const servers = JSON.parse(result.document).mcpServers
    assert.ok(Object.hasOwn(servers, "__proto__"))
    assert.equal(servers.__proto__.command, "exe")
    assert.ok(Object.hasOwn(servers.normal.env, "__proto__"))
    assert.equal({}.command, undefined)
  }
  const toml = adaptImportDocument("[mcp_servers.__proto__]\ncommand='exe'\n[mcp_servers.headers]\nurl='https://example.invalid/mcp'\nenv_http_headers={__proto__='TOKEN'}", "codex")
  assert.deepEqual(toml.invalid, [])
  const servers = JSON.parse(toml.document).mcpServers
  assert.ok(Object.hasOwn(servers, "__proto__"))
  assert.equal(servers.headers.headers.__proto__, "${TOKEN}")
})

test("malformed foreign documents throw safe errors instead of looking like an empty import", () => {
  for (const format of ["codex", "omp", "qoder", "kimi", "cursor", "gemini", "vscode", "opencode"]) {
    for (const text of ["private-fixture-malformed = [", "[]", "{}", "null"]) {
      assert.throws(() => adaptImportDocument(text, format), (error) => {
        assert.ok(error instanceof ImportDocumentError)
        assert.ok(!error.message.includes("private-fixture"))
        assert.equal(error.cause, undefined)
        return true
      })
    }
  }
  assert.throws(() => adaptImportDocument('{"mcp": { // private-fixture-comment\n}}', "opencode"), /JSONC is unsupported/)
  assert.throws(() => adaptImportDocument("[mcp_servers.a]\ncommand='private-fixture-first'\ncommand='private-fixture-second'", "codex"), (error) => error instanceof ImportDocumentError && !error.message.includes("private-fixture"))
  const overflow = adaptImportDocument('{"mcpServers":{"bad":{"command":"exe","enabled":1e309},"good":{"command":"exe"}}}', "omp")
  assert.deepEqual(overflow.invalid.map((issue) => issue.id), ["bad"])
  assert.deepEqual(JSON.parse(overflow.document), { mcpServers: { good: { command: "exe" } } })
})

test("the selected foreign root cannot be shadowed by an unrelated native root", () => {
  for (const format of ["vscode", "opencode"]) {
    const entry = format === "opencode" ? { type: "local", command: [local.command] } : local
    const result = converted(format, { selected: entry }, { mcpServers: { wrong: { command: "private-fixture-command" } } })
    assert.deepEqual(Object.keys(JSON.parse(result.document).mcpServers), ["selected"])
    assert.deepEqual(result.warnings, ["Unrelated client settings are not imported."])
    assert.ok(!result.document.includes("private-fixture"))
  }
})

test("all foreign entries, including invalid ones, count toward the native owner's limit", () => {
  for (const format of ["codex", "omp", "qoder", "kimi", "cursor", "gemini", "vscode", "opencode"]) {
    const entries = Object.fromEntries(Array.from({ length: MAX_IMPORT_ENTRIES }, (_, index) => [`s${index}`, { futureFeature: "fixture-secret" }]))
    const text = format === "codex" ? Object.keys(entries).map((id) => `[mcp_servers.${id}]\nfutureFeature='fixture-secret'\n`).join("") : source(format, entries)
    const accepted = adaptImportDocument(text, format)
    assert.equal(accepted.invalid.length, MAX_IMPORT_ENTRIES)
    assert.deepEqual(JSON.parse(accepted.document), { mcpServers: {} })
    const excess = format === "codex" ? `${text}[mcp_servers.extra]\ncommand='exe'\n` : source(format, { ...entries, extra: local })
    assert.throws(() => adaptImportDocument(excess, format), /1,000 entry limit/)
  }
})

test("the byte limit is UTF-8, checked before parsing and after normalization", () => {
  for (const format of ["json", "omp", "codex"]) {
    const prefix = format === "codex" ? "[mcp_servers]\n" : '{"mcpServers":{}}'
    const exact = prefix + " ".repeat(MAX_IMPORT_BYTES - prefix.length)
    assert.doesNotThrow(() => adaptImportDocument(exact, format))
    assert.throws(() => adaptImportDocument(exact + " ", format), /8 MiB limit/)
    assert.throws(() => adaptImportDocument("€".repeat(Math.floor(MAX_IMPORT_BYTES / 3) + 1), format), /8 MiB limit/)
  }
  const toml = "[mcp_servers.a]\ncommand='exe'\nargs=['''" + "\n".repeat(MAX_IMPORT_BYTES / 2 + 32) + "''']"
  assert.ok(new TextEncoder().encode(toml).byteLength < MAX_IMPORT_BYTES)
  assert.throws(() => adaptImportDocument(toml, "codex"), /8 MiB limit/)
})
