import { parse as parseToml } from "smol-toml"

export type McpImportFormat = "json" | "codex" | "omp" | "qoder" | "kimi" | "cursor" | "gemini" | "vscode" | "opencode"
export type ImportAdapterIssue = {
  id: string
  transport?: "stdio" | "http" | "sse"
  fields: string[]
  message: string
}
export type AdaptedImport = { document: string; invalid: ImportAdapterIssue[]; warnings: string[] }

export const MAX_IMPORT_BYTES = 8 * 1024 * 1024
export const MAX_IMPORT_ENTRIES = 1_000

export class ImportDocumentError extends Error {
  override name = "ImportDocumentError"
}

type Entry = Record<string, unknown>

const nativeFields: Record<string, true> = {
  type: true, command: true, args: true, env: true, cwd: true, enabled: true,
  timeout: true, url: true, headers: true, auth: true, oauth: true,
}
const oauthFields: Record<string, true> = {
  clientId: true, callbackPort: true, authServerMetadataUrl: true, scopes: true,
}
const codexFields: Record<string, true> = {
  command: true, args: true, env: true, cwd: true, enabled: true, url: true,
  http_headers: true, env_http_headers: true, bearer_token_env_var: true, tool_timeout_sec: true,
}
const unsupportedFields: Record<string, true> = {
  startup_timeout_sec: true, startup_timeout_ms: true, enabled_tools: true, disabled_tools: true, env_vars: true, bearer_token: true,
  requestIdFormat: true, instructions: true, credentialId: true, qoder_url: true, trust: true, includeTools: true, excludeTools: true, alwaysAllow: true,
  environment_id: true, deferred: true, startupTimeoutMs: true, enabledTools: true, disabledTools: true, envFile: true, inputs: true, sandbox: true,
  targetAudience: true, targetServiceAccount: true, authProviderType: true, environment: true,
}

class EntryError extends Error {
  constructor(readonly fields: string[], message = "This entry uses unsupported client settings.") {
    super(message)
  }
}

function object(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
}

function has(entry: Entry, field: string): boolean {
  return Object.hasOwn(entry, field)
}

function reject(field: string, message?: string): never {
  throw new EntryError([field], message)
}

function unknownFields(entry: Entry, known: Record<string, true>): void {
  const fields = Object.keys(entry).filter((field) => !Object.hasOwn(known, field))
  if (fields.length) {
    throw new EntryError([...new Set(fields.map((field) => Object.hasOwn(unsupportedFields, field) ? field : "unsupported field"))])
  }
}

function rename(entry: Entry, from: string, to: string): void {
  if (!has(entry, from)) return
  if (has(entry, to)) reject(from, "This entry sets conflicting client and native fields.")
  entry[to] = entry[from]
  delete entry[from]
}

function environmentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function bearerReference(entry: Entry, field: string): void {
  if (!has(entry, field)) return
  const name = entry[field]
  if (!environmentName(name)) reject(field, "The bearer token field must name an environment variable.")
  if (has(entry, "auth") || has(entry, "oauth") || (object(entry.headers) && Object.keys(entry.headers).some((name) => name.toLowerCase() === "authorization"))) {
    reject(field, "This entry sets conflicting authentication fields.")
  }
  entry.auth = { type: "bearer", token: `\${${name}}` }
  delete entry[field]
}

function codex(entry: Entry): void {
  unknownFields(entry, codexFields)
  if (has(entry, "url")) entry.type = "http"
  rename(entry, "http_headers", "headers")
  if (has(entry, "env_http_headers")) {
    if (!object(entry.env_http_headers)) reject("env_http_headers", "Environment headers must be a table of variable names.")
    if (has(entry, "headers") && !object(entry.headers)) reject("http_headers", "Headers must be a table of strings.")
    const headers: Entry = { ...(object(entry.headers) ? entry.headers : {}) }
    const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
    for (const [header, name] of Object.entries(entry.env_http_headers)) {
      if (!environmentName(name)) reject("env_http_headers", "Environment headers must name environment variables.")
      if (names.has(header.toLowerCase())) reject("env_http_headers", "Header names must not conflict, regardless of case.")
      Object.defineProperty(headers, header, { value: `\${${name}}`, enumerable: true, configurable: true, writable: true })
      names.add(header.toLowerCase())
    }
    entry.headers = headers
    delete entry.env_http_headers
  }
  if (object(entry.headers)) {
    const names = Object.keys(entry.headers).map((name) => name.toLowerCase())
    if (new Set(names).size !== names.length) reject("http_headers", "Header names must not conflict, regardless of case.")
  }
  bearerReference(entry, "bearer_token_env_var")
  if (has(entry, "tool_timeout_sec")) {
    const seconds = entry.tool_timeout_sec
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      reject("tool_timeout_sec", "Tool timeout must be a finite positive number of seconds.")
    }
    const millis = seconds * 1000
    const integral = Math.round(millis)
    const tolerance = Math.abs(millis) * Number.EPSILON * 2
    if (!Number.isSafeInteger(integral) || Math.abs(millis - integral) > tolerance) {
      reject("tool_timeout_sec", "Tool timeout must convert to a whole number of milliseconds.")
    }
    entry.timeout = integral
    delete entry.tool_timeout_sec
  }
}

function opencode(entry: Entry): void {
  for (const field of ["oauth", "timeout"]) if (has(entry, field)) reject(field)
  if (entry.type === "local") {
    if (has(entry, "args") || has(entry, "env")) reject("command", "OpenCode command and environment conflict with native fields.")
    if (!Array.isArray(entry.command) || !entry.command.length || entry.command.some((value) => typeof value !== "string")) {
      reject("command", "OpenCode local command must be a nonempty array of strings.")
    }
    const [command, ...args] = entry.command
    entry.command = command
    entry.args = args
    rename(entry, "environment", "env")
    entry.type = "stdio"
  } else if (entry.type === "remote") {
    entry.type = "http"
  } else {
    reject("type", "OpenCode transport must be local or remote.")
  }
}

function translateString(text: string, format: McpImportFormat, field: string): string {
  if (format === "cursor" || format === "vscode" || format === "opencode") {
    const prefix = format === "opencode" ? "{env:" : "${env:"
    let remaining = text
    let translated = ""
    let start: number
    while ((start = remaining.indexOf(prefix)) !== -1) {
      const before = remaining.slice(0, start)
      if (before.includes("${")) reject(field, "This entry uses unsupported variable expansion.")
      translated += before
      const rest = remaining.slice(start + prefix.length)
      const end = rest.indexOf("}")
      const name = rest.slice(0, end)
      if (end === -1 || !environmentName(name)) reject(field, "This entry uses unsupported variable expansion.")
      translated += `\${${name}}`
      remaining = rest.slice(end + 1)
    }
    if (remaining.includes("${")) reject(field, "This entry uses unsupported variable expansion.")
    text = translated + remaining
  }
  if (text.includes("{file:") || text.includes("{input:") || text.includes("$(")) {
    reject(field, "This entry uses unsupported file, input, or command expansion.")
  }
  let remaining = text
  let start: number
  while ((start = remaining.indexOf("$")) !== -1) {
    remaining = remaining.slice(start + 1)
    if (remaining.startsWith("{")) {
      const end = remaining.indexOf("}")
      const body = remaining.slice(1, end)
      const name = body.split(":-", 1)[0]
      if (end === -1 || !environmentName(name)) reject(field, "This entry uses unsupported variable expansion.")
      remaining = remaining.slice(end + 1)
    } else if (/^[A-Za-z_]/.test(remaining)) {
      reject(field, "This entry uses unsupported variable expansion.")
    }
  }
  if (format === "gemini" && field === "env" && /%[A-Za-z_][A-Za-z0-9_]*%/.test(text)) {
    reject(field, "Windows environment expansion is unsupported.")
  }
  return text
}

function translateValue(value: unknown, format: McpImportFormat, field: string): unknown {
  if (typeof value === "string") return translateString(value, format, field)
  if (Array.isArray(value)) return value.map((item) => translateValue(item, format, field))
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, translateValue(item, format, field)]))
  return value
}

function adaptEntry(entry: Entry, format: McpImportFormat): void {
  switch (format) {
    case "codex":
      codex(entry)
      break
    case "omp":
      if (has(entry, "timeout")) reject("timeout", "OMP request timeout is not a tool-only timeout.")
      for (const field of ["env", "headers"]) {
        const values = entry[field]
        if (object(values) && Object.values(values).some((value) => typeof value === "string" && (value.startsWith("!") || environmentName(value)))) {
          reject(field, "OMP command and environment-name indirection is unsupported.")
        }
      }
      break
    case "qoder":
      if (has(entry, "timeout")) reject("timeout", "Qoder connection/request timeout is not a tool-only timeout.")
      if (has(entry, "disabled")) {
        if (typeof entry.disabled !== "boolean") reject("disabled", "The disabled field must be a boolean.")
        if (has(entry, "enabled")) reject("disabled", "Disabled and enabled must not both be set.")
        entry.enabled = !entry.disabled
        delete entry.disabled
      }
      break
    case "kimi":
      rename(entry, "transport", "type")
      rename(entry, "toolTimeoutMs", "timeout")
      bearerReference(entry, "bearerTokenEnvVar")
      break
    case "cursor":
      if (has(entry, "auth")) reject("auth", "Cursor authentication settings have no supported equivalent.")
      break
    case "gemini":
      if (has(entry, "timeout")) reject("timeout", "Gemini request timeout is not a tool-only timeout.")
      if (has(entry, "httpUrl")) {
        if (has(entry, "type")) reject("httpUrl", "Gemini endpoint fields conflict with an explicit type.")
        rename(entry, "httpUrl", "url")
        entry.type = "http"
      } else if (has(entry, "url")) {
        if (has(entry, "type")) reject("url", "Gemini endpoint fields conflict with an explicit type.")
        entry.type = "sse"
      }
      break
    case "opencode":
      opencode(entry)
      break
  }
  if (!has(entry, "type") && has(entry, "url") && !has(entry, "command")) entry.type = "http"
  unknownFields(entry, nativeFields)
  if (object(entry.auth) && Object.keys(entry.auth).some((field) => field !== "type" && field !== "token")) {
    reject("auth", "Managed credentials and unsupported authentication members cannot be imported.")
  }
  if (object(entry.oauth)) {
    if (Object.keys(entry.oauth).some((field) => !Object.hasOwn(oauthFields, field))) reject("oauth", "Unsupported OAuth settings cannot be imported.")
    if (format === "omp" && Object.values(entry.oauth).some((value) => typeof value === "string" && value.includes("${"))) {
      reject("oauth", "OMP OAuth variable expansion has no supported equivalent.")
    }
  }
  if (["cursor", "gemini", "vscode", "opencode"].includes(format)) {
    for (const field of ["command", "args", "env", "cwd", "url", "headers", "auth"]) {
      if (has(entry, field)) entry[field] = translateValue(entry[field], format, field)
    }
  }
}

function transport(value: unknown, format: McpImportFormat): ImportAdapterIssue["transport"] {
  if (!object(value)) return undefined
  if (value.type === "http" || value.type === "streamable-http" || value.type === "remote" || has(value, "httpUrl")) return "http"
  if (value.type === "sse" || value.transport === "sse") return "sse"
  if (value.type === "stdio" || value.type === "local" || has(value, "command")) return "stdio"
  if (has(value, "url")) return format === "gemini" ? "sse" : "http"
  return undefined
}

function jsonCompatible(value: unknown): boolean {
  if (typeof value === "bigint" || value instanceof Date) return false
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonCompatible)
  if (object(value)) return Object.values(value).every(jsonCompatible)
  return true
}

function checkBytes(text: string): void {
  if (text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new ImportDocumentError("The import document exceeds the 8 MiB limit.")
  }
}

/** Converts only foreign client semantics. Native entry validation and all writes remain with the daemon. */
export function adaptImportDocument(text: string, format: McpImportFormat): AdaptedImport {
  checkBytes(text)
  if (format === "json") return { document: text, invalid: [], warnings: [] }
  let root: unknown
  try {
    root = format === "codex" ? parseToml(text, { integersAsBigInt: "asNeeded" }) : JSON.parse(text)
  } catch {
    throw new ImportDocumentError(format === "codex" ? "The document is not valid TOML." : "The document is not valid JSON. JSONC is unsupported.")
  }
  if (!object(root)) throw new ImportDocumentError("The import document must be an object.")
  const key = format === "codex" ? "mcp_servers" : format === "vscode" ? "servers" : format === "opencode" ? "mcp" : "mcpServers"
  const servers = root[key]
  if (!has(root, key) || !object(servers)) throw new ImportDocumentError(`The document must contain a ${key} object.`)
  const entries = Object.entries(servers)
  if (entries.length > MAX_IMPORT_ENTRIES) throw new ImportDocumentError("The import document exceeds the 1,000 entry limit.")
  const warnings = Object.keys(root).some((name) => name !== key) ? ["Unrelated client settings are not imported."] : []
  const normalized: Entry = Object.create(null)
  const invalid: ImportAdapterIssue[] = []
  for (const [id, value] of entries) {
    try {
      if (!jsonCompatible(value)) reject("entry", "Dates, non-finite numbers, and oversized integers are unsupported in MCP entries.")
      if (object(value)) {
        const entry = { ...value }
        adaptEntry(entry, format)
        normalized[id] = entry
      } else {
        normalized[id] = value
      }
    } catch (error) {
      if (!(error instanceof EntryError)) throw error
      invalid.push({ id, transport: transport(value, format), fields: error.fields, message: error.message })
    }
  }
  const document = JSON.stringify({ mcpServers: normalized })
  checkBytes(document)
  return { document, invalid, warnings }
}
