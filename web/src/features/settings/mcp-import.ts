import { MAX_IMPORT_BYTES, type McpImportFormat } from "./mcp-adapters"

export const IMPORT_FORMATS: { value: McpImportFormat; label: string }[] = [
  { value: "json", label: "Standard MCP JSON / Claude Code / Windsurf" },
  { value: "codex", label: "Codex TOML" },
  { value: "omp", label: "OMP JSON" },
  { value: "qoder", label: "Qoder JSON" },
  { value: "kimi", label: "Kimi Code JSON" },
  { value: "cursor", label: "Cursor JSON" },
  { value: "gemini", label: "Gemini CLI JSON" },
  { value: "vscode", label: "VS Code JSON" },
  { value: "opencode", label: "OpenCode JSON" },
]

export type ImportCandidate = {
  file: File
  path: string
  format: McpImportFormat
}

export type ImportSource = {
  path: string
  content: string
}

type ImportSourceErrorKind = "unreadable" | "empty" | "too-large"

export class ImportSourceError extends Error {
  override name = "ImportSourceError"
  constructor(readonly kind: ImportSourceErrorKind) {
    super(kind)
  }
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "")
}

/** Returns the adapter implied by a browser-visible file name or relative path. */
export function formatForImportPath(path: string): McpImportFormat | undefined {
  const normalized = normalizedPath(path)
  if (/(^|\/)\.omp\/(?:agent\/)?\.?mcp\.json$/.test(normalized) || /(^|\/)\.omp\/profiles\/[^/]+\/agent\/\.?mcp\.json$/.test(normalized)) return "omp"
  if (/(^|\/)\.codex\/config\.toml$/.test(normalized)) return "codex"
  if (/(^|\/)\.qoder\/settings(?:\.local)?\.json$/.test(normalized)) return "qoder"
  if (/(^|\/)\.kimi(?:-code)?\/mcp\.json$/.test(normalized)) return "kimi"
  if (/(^|\/)\.cursor\/mcp\.json$/.test(normalized)) return "cursor"
  if (/(^|\/)\.gemini\/settings\.json$/.test(normalized)) return "gemini"
  if (/(^|\/)\.vscode\/mcp\.json$/.test(normalized)) return "vscode"
  if (/(^|\/)opencode\.jsonc?$/.test(normalized)) return "opencode"
  if (/(^|\/)(?:\.codeium\/windsurf|\.windsurf|\.devin|\.config\/devin)\/mcp_config(?:\.local)?\.json$/.test(normalized)) return "json"
  if (/(^|\/)\.copilot\/mcp-config\.json$/.test(normalized)) return "json"
  if (/(^|\/)(?:\.claude\.json|\.mcp\.json|mcp\.json)$/.test(normalized)) return "json"
  return undefined
}

export function collectImportCandidates(files: Iterable<File>): ImportCandidate[] {
  const candidates: ImportCandidate[] = []
  for (const file of files) {
    const path = normalizedPath(file.webkitRelativePath || file.name)
    const format = formatForImportPath(path)
    if (format === undefined) continue
    candidates.push({ path, format, file })
  }
  return candidates.sort((left, right) => left.path.localeCompare(right.path))
}

/** Reads a browser File once. A File is a snapshot; reacquire it to read changed disk content. */
export async function readImportFile(
  file: File,
  path: string,
): Promise<ImportSource> {
  if (file.size > MAX_IMPORT_BYTES) throw new ImportSourceError("too-large")
  let content: string
  try {
    content = await file.text()
  } catch {
    throw new ImportSourceError("unreadable")
  }
  if (!content.trim()) throw new ImportSourceError("empty")
  if (new TextEncoder().encode(content).byteLength > MAX_IMPORT_BYTES) throw new ImportSourceError("too-large")
  return { path: normalizedPath(path), content }
}
