<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from "vue"
import { ArrowRight, Check, ChevronDown, FileJson, FolderOpen, LockKeyhole, Upload, X } from "lucide-vue-next"
import { useSettingsText } from "../../i18n/settings-general"
import { RpcError } from "../../rpc/client"
import { readMcpImportApplied, readMcpImportPreview, type McpImportEntry, type McpImportPreview, type McpImportResolution } from "../../rpc/general-settings"
import { useConnectionStore } from "../../stores/connection"
import { collectImportCandidates, formatForImportPath, IMPORT_FORMATS, ImportSourceError, readImportFile, type ImportCandidate, type ImportSource } from "./mcp-import"
import { adaptImportDocument, ImportDocumentError, type AdaptedImport, type McpImportFormat } from "./mcp-adapters"

const props = defineProps<{ cwd: string; disabled: boolean; refresh: () => Promise<void> }>()
const emit = defineEmits<{ busy: [boolean]; dirty: [boolean] }>()
const s = useSettingsText()
const connection = useConnectionStore()
const headingId = useId()
const dialog = ref<HTMLDialogElement>()
const heading = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const directoryInput = ref<HTMLInputElement>()
const opened = ref(false)
const step = ref<1 | 2 | 3>(1)
const expandedId = ref<string>()
const source = shallowRef<ImportSource>()
const candidates = shallowRef<ImportCandidate[]>()
const candidateIndex = ref("")
const format = ref<McpImportFormat>("json")
const destination = ref<"user" | "project">("user")
const preview = shallowRef<McpImportPreview>()
const adapted = shallowRef<AdaptedImport>()
const choices = ref<(McpImportResolution & { selected: boolean })[]>([])
const busy = ref(false)
const stale = ref(false)
const finished = ref(false)
const error = ref("")
const needsReselect = ref(false)
const outcome = ref<{ imported: string[]; replaced: string[]; renamed: string[]; unchanged: string[]; skipped: string[]; review: string[] }>()
let mounted = true
let generation = 0

const supported = computed(() => connection.supports("mcp.import.preview") && connection.supports("mcp.import.apply"))
const blocked = computed(() => busy.value || props.disabled || connection.phase !== "connected")
const selected = computed(() => choices.value.filter(choice => choice.selected))
const formatLabel = computed(() => IMPORT_FORMATS.find(option => option.value === format.value)!.label)
const targetLabel = computed(() => destination.value === "user" ? s("Dim user scope", "Dim 用户") : `${s("Project", "项目")} · ${props.cwd}`)
const canPreview = computed(() => supported.value && !!source.value && (destination.value === "user" || !!props.cwd))
const canApply = computed(() => canPreview.value && !!preview.value && !!adapted.value && !stale.value && selected.value.length > 0)
watch(busy, value => emit("busy", value), { flush: "sync" })
watch(source, value => { adapted.value = undefined; emit("dirty", !!value) }, { flush: "sync" })
watch([format, destination, () => props.cwd], () => {
  generation += 1
  busy.value = false
  preview.value = undefined
  adapted.value = undefined
  choices.value = []
  expandedId.value = undefined
  outcome.value = undefined
  stale.value = false
  finished.value = false
  step.value = 1
}, { flush: "sync" })
watch(() => connection.phase, phase => {
  if (!opened.value || phase === "connected") return
  generation += 1
  busy.value = false
  if (preview.value && !finished.value) { stale.value = true; step.value = 2 }
  error.value = s("Connection lost. An in-flight import may have changed the destination; review it after reconnecting. You can cancel this dialog offline.", "连接已断开。进行中的导入可能已更改目标；请在重连后复核。离线时可取消此对话框。")
}, { flush: "sync" })
watch(step, async () => { await nextTick(); heading.value?.focus() })

async function open(): Promise<void> {
  if (blocked.value || !supported.value) return
  format.value = "json"
  destination.value = props.cwd ? "project" : "user"
  opened.value = true
  const token = generation
  await nextTick()
  if (!current(token)) return
  dialog.value?.showModal()
  heading.value?.focus()
}
function close(): void {
  if (busy.value) return
  generation += 1
  dialog.value?.close()
  opened.value = false
  source.value = undefined
  candidates.value = undefined
  candidateIndex.value = ""
  preview.value = undefined
  choices.value = []
  expandedId.value = undefined
  step.value = 1
  stale.value = false
  finished.value = false
  error.value = ""
  outcome.value = undefined
  needsReselect.value = false
}
function sourceError(cause: unknown): string {
  if (cause instanceof ImportSourceError) {
    if (cause.kind === "empty") return s("The selected file is empty.", "所选文件为空。")
    if (cause.kind === "too-large") return s("The selected file exceeds the 8 MiB import limit.", "所选文件超过 8 MiB 导入限制。")
  }
  return s("The selected file could not be read. Re-select the file or folder to acquire a fresh browser snapshot.", "无法读取所选文件。请重新选择文件或目录以获取新的浏览器快照。")
}
function rpcError(cause: unknown): string {
  return cause instanceof RpcError ? cause.message : s("The import request did not complete. The destination may have changed; preview again before retrying.", "导入请求未完成。目标可能已更改，请重新预览后再试。")
}
function current(token: number): boolean {
  return mounted && opened.value && token === generation
}
async function choose(file: File, path = file.webkitRelativePath || file.name, adapter?: McpImportFormat): Promise<void> {
  format.value = adapter ?? formatForImportPath(path) ?? (/\.toml$/i.test(file.name) ? "codex" : format.value)
  const token = ++generation
  busy.value = true
  source.value = undefined
  preview.value = undefined
  choices.value = []
  expandedId.value = undefined
  error.value = ""
  outcome.value = undefined
  finished.value = false
  needsReselect.value = false
  step.value = 1
  try {
    const loaded = await readImportFile(file, path)
    if (current(token)) source.value = loaded
  } catch (cause) {
    if (current(token)) {
      needsReselect.value = cause instanceof ImportSourceError && cause.kind === "unreadable"
      error.value = sourceError(cause)
    }
  } finally { if (current(token)) busy.value = false }
}
async function fileChanged(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file || blocked.value) return
  candidates.value = undefined
  candidateIndex.value = ""
  await choose(file)
}
function directoryChanged(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ""
  if (!files.length || blocked.value) return
  generation += 1
  candidates.value = collectImportCandidates(files)
  candidateIndex.value = ""
  source.value = undefined
  preview.value = undefined
  choices.value = []
  expandedId.value = undefined
  error.value = ""
  outcome.value = undefined
  finished.value = false
  needsReselect.value = false
  step.value = 1
}
async function candidateChanged(): Promise<void> {
  if (blocked.value || candidateIndex.value === "") return
  const candidate = candidates.value?.[Number(candidateIndex.value)]
  if (candidate) await choose(candidate.file, candidate.path, candidate.format)
}
function parameters(document: string): { source: "user" | "project"; document: string; cwd?: string } {
  return { source: destination.value, document, ...(props.cwd ? { cwd: props.cwd } : {}) }
}
async function loadPreview(): Promise<void> {
  if (blocked.value || !canPreview.value) return
  const token = ++generation
  busy.value = true
  error.value = ""
  outcome.value = undefined
  try {
    const converted = adaptImportDocument(source.value!.content, format.value)
    const result = await connection.client.call("mcp.import.preview", parameters(converted.document), readMcpImportPreview)
    if (!current(token)) return
    adapted.value = converted
    preview.value = result
    choices.value = result.entries.map(entry => ({ id: entry.id, action: "import", selected: false }))
    expandedId.value = undefined
    stale.value = false
    step.value = 2
  } catch (cause) {
    if (current(token)) { error.value = cause instanceof ImportDocumentError ? cause.message : rpcError(cause); stale.value = true }
  } finally { if (current(token)) busy.value = false }
}
function resolve(index: number, action: "skip" | "rename" | "replace"): void {
  const choice = choices.value[index]!
  choice.action = action === "skip" ? "import" : action
  choice.selected = action !== "skip"
  if (action === "rename") choice.newId ??= `${choice.id}-local`
  else delete choice.newId
  expandedId.value = choice.id
}
function review(): void {
  if (blocked.value || !canApply.value) return
  error.value = ""
  const targets = selected.value.map(choice => choice.action === "rename" ? choice.newId!.trim() : choice.id)
  if (targets.some(id => !id) || new Set(targets).size !== targets.length) {
    error.value = s("Selected target IDs must be nonempty and unique.", "所选目标 ID 不能为空且必须唯一。")
    return
  }
  const unresolved = selected.value.find(choice => preview.value!.entries.find(entry => entry.id === choice.id)?.status === "conflict" && choice.action === "import")
  if (unresolved) {
    expandedId.value = unresolved.id
    error.value = s("Resolve each target conflict by skipping, renaming, or explicitly allowing replacement.", "请通过跳过、重命名或明确允许替换解决每个目标冲突。")
    return
  }
  step.value = 3
}
async function apply(): Promise<void> {
  if (step.value !== 3 || blocked.value || !canApply.value) return
  const token = ++generation
  const reviewed = preview.value!
  const resolutions: McpImportResolution[] = choices.value.map(choice => ({ id: choice.id, action: choice.selected ? choice.action : "skip", ...(choice.selected && choice.action === "rename" ? { newId: choice.newId!.trim() } : {}) }))
  const summary = { imported: [] as string[], replaced: [] as string[], renamed: [] as string[], unchanged: [] as string[], skipped: [] as string[], review: [] as string[] }
  for (const [index, resolution] of resolutions.entries()) {
    if (resolution.action === "skip") summary.skipped.push(resolution.id)
    else if (resolution.action === "import" && reviewed.entries[index]!.status === "identical") summary.unchanged.push(resolution.id)
    else if (resolution.action === "replace") summary.replaced.push(resolution.id)
    else if (resolution.action === "rename") summary.renamed.push(resolution.newId!)
    else summary.imported.push(resolution.id)
  }
  busy.value = true
  error.value = ""
  outcome.value = undefined
  try {
    await connection.client.call("mcp.import.apply", { ...parameters(adapted.value!.document), expectedVersion: reviewed.revision, resolutions }, readMcpImportApplied)
    if (!current(token)) return
    outcome.value = summary
    finished.value = true
    source.value = undefined
    candidates.value = undefined
  } catch (cause) {
    if (!current(token)) return
    step.value = 2
    if (cause instanceof RpcError && cause.appError === "mcp_import_partial") {
      summary.review = [...summary.imported, ...summary.replaced, ...summary.renamed]
      summary.imported = []
      summary.replaced = []
      summary.renamed = []
      outcome.value = summary
      error.value = s("The import was only partially written. All accepted target IDs below need review; none is reported as completed. Preview again before explicitly replacing an incomplete entry.", "导入仅部分写入。下列所有已接受的目标 ID 都需要复核；不会将任何条目标为完成。请重新预览，再明确替换未完成的条目。")
    } else if (cause instanceof RpcError && cause.appError === "mcp_settings_conflict") {
      error.value = s("The MCP source changed since this preview; no entry was imported, and an entry it would have replaced may now be disabled. Preview again before applying.", "自本次预览后 MCP 源已更改；未导入任何条目，它原本会替换的条目现在可能已禁用。请重新预览后再应用。")
    } else error.value = rpcError(cause)
  } finally {
    if (current(token)) {
      stale.value = true
      try { await props.refresh() }
      catch { if (current(token)) error.value += s(" Catalog refresh failed. Reload the catalog before another change.", " 目录刷新失败，请重新加载后再更改。") }
      if (current(token)) busy.value = false
    }
  }
}
function statusText(entry: McpImportEntry): string {
  switch (entry.status) {
    case "identical": return s("Identical", "相同")
    case "changed": return s("Changed", "已变更")
    case "conflict": return s("Same ID", "同名")
    case "invalid": return s("Not importable", "不可导入")
  }
}
onBeforeUnmount(() => { mounted = false; generation += 1; source.value = undefined; candidates.value = undefined; emit("busy", false); emit("dirty", false) })
</script>

<template>
  <button class="ui-button" data-size="md" data-variant="secondary" type="button" :disabled="blocked || !supported" :title="supported ? undefined : s('This daemon does not support MCP import.', '此守护进程不支持 MCP 导入。')" @click="open"><Upload :size="14" aria-hidden="true" />{{ s('Import…', '导入…') }}</button>
  <Teleport to="body">
    <dialog ref="dialog" class="ui-dialog mcp-import" data-size="lg" :aria-labelledby="headingId" @cancel.self.prevent="close" @close="!dialog?.open && close()">
      <template v-if="opened">
        <header class="ui-dialog-header">
          <div><h2 :id="headingId" ref="heading" class="ui-dialog-title" tabindex="-1">{{ s('Import MCP configuration', '导入 MCP 配置') }}</h2><p class="ui-dialog-description">{{ s('Bring in selected servers. Review before importing.', '选择要带入 Dim 的服务器，确认后再导入。') }}</p></div>
          <button class="ui-icon-button ui-dialog-close" data-size="sm" data-variant="close" type="button" :aria-label="s('Close import', '关闭导入')" :disabled="busy" @click="close"><X :size="16" aria-hidden="true" /></button>
        </header>
        <ol class="import-steps" :aria-label="s('Import steps', '导入步骤')"><li v-for="(label, index) in [s('Source', '来源'), s('Preview', '预览'), s('Confirm', '确认')]" :key="label" :aria-current="step === index + 1 ? 'step' : undefined" :data-complete="step > index + 1 || finished"><span class="step-number"><Check v-if="step > index + 1 || finished" :size="12" aria-hidden="true" /><template v-else>{{ index + 1 }}</template></span>{{ label }}</li></ol>
        <input ref="fileInput" class="sr-only" type="file" tabindex="-1" :disabled="blocked" :aria-label="s('Import configuration file', '导入配置文件')" @change="fileChanged" />
        <input ref="directoryInput" class="sr-only" type="file" tabindex="-1" webkitdirectory multiple :disabled="blocked" :aria-label="s('Discover in selected directory', '在选定目录中发现配置')" @change="directoryChanged" />
        <div class="import-content">
          <template v-if="step === 1">
            <fieldset class="source-options" :disabled="blocked">
              <button class="ui-button source-option" data-variant="secondary" type="button" @click="fileInput?.click()"><FileJson :size="20" aria-hidden="true" /><span><strong>{{ s('Choose a config file', '选择配置文件') }}</strong><small>JSON / TOML</small></span></button>
              <button class="ui-button source-option" data-variant="secondary" type="button" @click="directoryInput?.click()"><FolderOpen :size="20" aria-hidden="true" /><span><strong>{{ s('Find in a folder', '从目录查找') }}</strong><small>{{ s('Only the folder you choose', '仅检查你选择的目录') }}</small></span></button>
            </fieldset>
            <label v-if="candidates?.length" class="import-field"><span>{{ s('Discovered configuration', '发现的配置') }}</span><select v-model="candidateIndex" class="ui-field" data-size="md" :disabled="blocked" @change="candidateChanged"><option value="" disabled>{{ s('Choose a source file', '选择源文件') }}</option><option v-for="(candidate, index) in candidates" :key="candidate.path" :value="String(index)">{{ candidate.path }} · {{ IMPORT_FORMATS.find(option => option.value === candidate.format)?.label }}</option></select></label>
            <p v-if="candidates && !candidates.length" class="import-empty" role="status">{{ s('No recognized MCP configuration files were found in the selected directory. Choose a file directly instead.', '所选目录中未发现已知 MCP 配置文件，也可以直接选择文件。') }}</p>
            <p v-if="!source" class="import-help">{{ s('Claude Code, Codex, OMP, Qoder, Kimi Code, Cursor and more. No background scan or server execution.', '支持 Claude Code、Codex、OMP、Qoder、Kimi Code、Cursor 等。不会后台扫描或运行服务器。') }}</p>
          </template>
          <div v-if="source" class="import-source"><FileJson :size="20" aria-hidden="true" /><div><strong>{{ formatLabel }}</strong><code>{{ source.path }}</code></div><button v-if="step !== 1" class="ui-button" data-size="sm" data-variant="link" type="button" :disabled="blocked" @click="step = 1">{{ s('Change source', '更换来源') }}</button></div>
          <template v-if="step === 1 && source">
            <label class="import-field"><span>{{ s('Import target scope', '导入到') }}</span><select v-model="destination" class="ui-field" data-size="md" :disabled="blocked"><option value="user">{{ s('Dim user scope', 'Dim 用户') }}</option><option value="project" :disabled="!cwd">{{ s('Current project', '当前项目') }}</option></select></label>
            <p v-if="destination === 'project'" class="import-help">{{ cwd }}</p>
            <details class="format-options"><summary>{{ s('Format and supported clients', '格式与支持的客户端') }}<ChevronDown :size="14" aria-hidden="true" /></summary><label class="import-field"><span>{{ s('Source format / client', '来源格式 / 客户端') }}</span><select v-model="format" class="ui-field" data-size="md" :disabled="blocked"><option v-for="option in IMPORT_FORMATS" :key="option.value" :value="option.value">{{ option.label }}</option></select></label><p class="import-help">{{ s('Paths are browser filenames or relative paths. Custom files can use an explicit adapter. Unsupported fields and non-JSON syntax are reported; credential stores are not imported.', '显示浏览器文件名或相对路径。自定义文件可明确选择适配格式。不支持的字段和非 JSON 语法会报告，不导入凭据存储。') }}</p></details>
          </template>
          <section v-if="step === 2 && preview" :aria-label="s('Import preview', '导入预览')">
            <div class="selection-heading"><strong>{{ s('Select servers', '选择服务器') }}</strong><span>{{ s(`${selected.length} / ${preview.entries.length + (adapted?.invalid.length ?? 0)} selected`, `${selected.length} / ${preview.entries.length + (adapted?.invalid.length ?? 0)} 已选`) }}</span></div>
            <p v-for="warning in adapted?.warnings" :key="warning" class="ui-banner" data-tone="warning">{{ warning }}</p>
            <p class="import-help">{{ s('Top-level members the import does not carry', '导入不会携带的顶层成员') }}: {{ preview.unknownTopLevel.join(', ') || s('none', '无') }}.</p>
            <p v-if="!preview.entries.length && !adapted?.invalid.length" class="import-empty" role="status">{{ s('This configuration contains no MCP server entries.', '此配置不包含 MCP 服务器条目。') }}</p>
            <div v-else class="import-ledger">
              <div v-for="(entry, index) in preview.entries" :key="entry.id" class="entry-group" :data-expanded="expandedId === entry.id">
                <div class="import-row">
                  <input v-model="choices[index]!.selected" class="ui-check" type="checkbox" :aria-label="`${s('Select', '选择')} ${entry.id}`" :disabled="blocked || stale || entry.status === 'invalid'" @change="entry.status === 'conflict' && choices[index]!.selected ? expandedId = entry.id : undefined" />
                  <div class="entry-identity">
                    <div><strong>{{ entry.id }}</strong><span>{{ entry.transport ?? '—' }}</span></div>
                    <small v-if="entry.error">{{ entry.error }}</small>
                    <small v-if="entry.changes.length">{{ s('Changed fields', '变更字段') }}: {{ entry.changes.map(field => `${field.field} (${field.kind})`).join(', ') }}</small>
                    <small v-if="entry.unsupported.length">{{ s('Unsupported fields', '不支持的字段') }}: {{ entry.unsupported.map(field => `${field.field} (${field.effect})`).join(', ') }}</small>
                    <small v-if="entry.omitted">{{ s(`${entry.omitted} more field names are not listed.`, `另有 ${entry.omitted} 个字段名未列出。`) }}</small>
                    <small v-if="choices[index]!.action === 'rename'">{{ entry.id }} → {{ choices[index]!.newId }}</small>
                  </div>
                  <span class="entry-status" :data-new="entry.status === 'changed'">{{ choices[index]!.selected && choices[index]!.action === 'replace' ? s('Replace', '替换') : choices[index]!.selected && choices[index]!.action === 'rename' ? s('Rename', '重命名') : statusText(entry) }}</span>
                  <button v-if="entry.status !== 'invalid'" class="ui-icon-button" data-size="xs" data-variant="ghost" type="button" :aria-label="`${s('Actions for', '处理')} ${entry.id}`" :aria-expanded="expandedId === entry.id" :disabled="blocked || stale" @click="expandedId = expandedId === entry.id ? undefined : entry.id"><ChevronDown :size="14" aria-hidden="true" /></button>
                </div>
                <div v-if="expandedId === entry.id && entry.status !== 'invalid'" class="entry-resolution">
                  <div class="resolution-actions"><span>{{ s('Import action', '导入时') }}</span><div class="ui-segmented" :aria-label="`${s('Resolve', '处理方式')} ${entry.id}`"><button type="button" :disabled="blocked || stale" :aria-pressed="!choices[index]!.selected" @click="resolve(index, 'skip')">{{ s('Skip', '跳过') }}</button><button type="button" :disabled="blocked || stale" :aria-pressed="choices[index]!.selected && choices[index]!.action === 'rename'" @click="resolve(index, 'rename')">{{ s('Rename', '重命名') }}</button><button v-if="entry.status === 'conflict' || entry.status === 'identical'" type="button" :disabled="blocked || stale" :aria-pressed="choices[index]!.selected && choices[index]!.action === 'replace'" @click="resolve(index, 'replace')">{{ s('Replace', '替换') }}</button></div></div>
                  <label v-if="choices[index]!.selected && choices[index]!.action === 'rename'" class="rename-field"><span>{{ s('Target ID', '目标 ID') }}</span><input v-model="choices[index]!.newId" class="ui-field" data-size="md" data-mono :aria-label="`${s('Target ID', '目标 ID')} · ${entry.id}`" :disabled="blocked || stale" /></label>
                  <p class="import-help">{{ choices[index]!.action === 'replace' ? s('The existing target entry will be replaced only after final confirmation.', '最终确认后才会替换目标范围的现有条目。') : s('Keep the existing entry by using a different name, or skip this item.', '使用不同名称可保留现有条目，也可以跳过此项。') }}</p>
                </div>
              </div>
              <div v-for="issue in adapted?.invalid" :key="`adapter:${issue.id}`" class="entry-group">
                <div class="import-row">
                  <input class="ui-check" type="checkbox" :aria-label="`${s('Select', '选择')} ${issue.id}`" disabled />
                  <div class="entry-identity"><div><strong>{{ issue.id }}</strong><span>{{ issue.transport ?? '—' }}</span></div><small>{{ s('Rejected by source adapter', '来源适配器拒绝导入') }}</small><small>{{ issue.message }}</small><small v-if="issue.fields.length">{{ s('Unsupported fields', '不支持的字段') }}: {{ issue.fields.join(', ') }}</small></div>
                  <span class="entry-status">{{ s('Not importable', '不可导入') }}</span>
                </div>
              </div>
            </div>
          </section>
          <section v-if="step === 3" class="confirmation" :aria-label="s('Confirm import', '确认导入')">
            <template v-if="!finished"><h3>{{ s(`Review ${selected.length} selected entries`, `确认导入 ${selected.length} 项`) }}</h3><p class="import-help">{{ s('Only these entries will be copied. Source files stay unchanged.', '只复制以下条目，源文件保持不变。') }}</p><ul><li v-for="choice in selected" :key="choice.id"><code>{{ choice.id }}<template v-if="choice.action === 'rename'"> → {{ choice.newId?.trim() }}</template></code><span :class="{ 'replace-warning': choice.action === 'replace' }">{{ choice.action === 'replace' ? s('Replace target', '替换目标') : choice.action === 'rename' ? s('Rename', '重命名') : preview?.entries.find(entry => entry.id === choice.id)?.status === 'identical' ? s('Unchanged', '保持不变') : s('Add', '新增') }}</span></li></ul></template>
            <div v-else class="import-complete"><Check :size="24" aria-hidden="true" /><h3>{{ s('Import complete', '导入完成') }}</h3><p>{{ s('New or replaced servers are disabled. Identical entries keep their enabled state. Enable imported servers separately when ready.', '新增或替换的服务器保持禁用，相同条目保留启用状态。准备好后再单独启用导入的服务器。') }}</p></div>
          </section>
          <p v-if="busy" class="import-help" role="status">{{ step === 3 ? s('Importing and refreshing catalog…', '正在导入并刷新目录…') : s('Reading configuration…', '正在处理配置…') }}</p>
          <p v-if="error" class="ui-banner" data-tone="danger" role="alert">{{ error }}</p>
          <template v-if="outcome">
            <p v-if="finished" role="status">{{ s(`Imported ${outcome.imported.length}, replaced ${outcome.replaced.length}, renamed ${outcome.renamed.length}, skipped ${outcome.skipped.length}, unchanged ${outcome.unchanged.length}.`, `已导入 ${outcome.imported.length} 项，替换 ${outcome.replaced.length} 项，重命名 ${outcome.renamed.length} 项，跳过 ${outcome.skipped.length} 项，未改变 ${outcome.unchanged.length} 项。`) }}</p>
            <p v-if="outcome.review.length" class="import-help" role="status">{{ s('Accepted target IDs needing review', '需要复核的已接受目标 ID') }}: {{ outcome.review.join(', ') }}</p>
            <p v-if="outcome.imported.length || outcome.replaced.length || outcome.renamed.length" class="import-help">{{ s('Written target IDs', '已写入的目标 ID') }}: {{ [...outcome.imported, ...outcome.replaced, ...outcome.renamed].join(', ') }}</p>
            <p v-if="outcome.unchanged.length" class="import-help">{{ s('Unchanged entries', '未更改条目') }}: {{ outcome.unchanged.join(', ') }}</p>
            <p v-if="outcome.skipped.length" class="import-help">{{ s('Skipped entries', '已跳过条目') }}: {{ outcome.skipped.join(', ') }}</p>
          </template>
          <div v-if="stale && !finished" class="ui-banner stale-message" data-tone="warning" role="status"><span>{{ s('Review the current destination before importing again. Preview uses the selected file snapshot.', '再次导入前请复核当前目标。预览使用已选文件快照。') }}</span><button class="ui-button" data-size="sm" data-variant="secondary" type="button" :disabled="blocked || !canPreview" @click="loadPreview">{{ s('Refresh preview', '重新预览') }}</button></div>
          <div v-if="(source || needsReselect) && !finished" class="source-reselect"><p class="import-help">{{ s('Changed the file on disk? Re-select the file or folder to read its new contents.', '磁盘上的文件已更改？请重新选择文件或目录以读取新内容。') }}</p><div><button class="ui-button" data-size="sm" data-variant="link" type="button" :disabled="blocked" @click="fileInput?.click()">{{ s('Re-select file', '重新选择文件') }}</button><button class="ui-button" data-size="sm" data-variant="link" type="button" :disabled="blocked" @click="directoryInput?.click()">{{ s('Re-select folder', '重新选择目录') }}</button></div></div>
        </div>
        <div v-if="step !== 1 && !finished" class="import-destination"><div><span>{{ s('Import into', '导入到') }}</span><strong>{{ targetLabel }}</strong><button class="ui-button" data-size="xs" data-variant="ghost" type="button" :disabled="blocked" @click="step = 1">{{ s('Change', '更改') }}</button></div><p><LockKeyhole :size="12" aria-hidden="true" />{{ destination === 'project' ? s('New / replaced entries disabled · hidden values stay in user storage', '新增 / 替换条目保持禁用 · 隐藏值保留在用户存储') : s('New / replaced entries disabled · source files unchanged', '新增 / 替换条目保持禁用 · 源文件不变') }}</p></div>
        <footer class="ui-dialog-footer">
          <button v-if="!finished" class="ui-button cancel-import" data-size="md" data-variant="ghost" type="button" :disabled="busy" @click="close">{{ s('Cancel', '取消') }}</button>
          <button v-if="step > 1 && !finished" class="ui-button" data-size="md" data-variant="secondary" type="button" :disabled="busy" @click="step = step === 3 ? 2 : 1">{{ s('Back', '上一步') }}</button>
          <button v-if="step === 1" class="ui-button" data-size="md" data-variant="primary" type="button" :disabled="blocked || !canPreview" @click="loadPreview">{{ s('Preview configuration', '预览配置') }}<ArrowRight :size="14" aria-hidden="true" /></button>
          <button v-else-if="step === 2" class="ui-button" data-size="md" data-variant="primary" type="button" :disabled="blocked || !canApply" @click="review">{{ s(`Next · review ${selected.length}`, `下一步 · 确认 ${selected.length} 项`) }}<ArrowRight :size="14" aria-hidden="true" /></button>
          <button v-else-if="!finished" class="ui-button" data-size="md" data-variant="primary" type="button" :disabled="blocked || !canApply" @click="apply">{{ s(`Confirm import ${selected.length}`, `确认导入 ${selected.length} 项`) }}</button>
          <button v-else class="ui-button" data-size="md" data-variant="primary" type="button" :disabled="busy" @click="close">{{ s('Done', '完成') }}</button>
        </footer>
      </template>
    </dialog>
  </Teleport>
</template>

<style scoped>
.mcp-import { max-height: calc(100dvh - var(--space-12)); overflow: hidden; }
.mcp-import[open] { display: flex; flex-direction: column; }
.mcp-import > header, .import-steps, .import-destination, .ui-dialog-footer { flex-shrink: 0; }
.mcp-import .ui-dialog-title { font-size: var(--text-lg); font-weight: var(--weight-medium); letter-spacing: normal; }
.import-steps { display: flex; list-style: none; padding: 0; gap: var(--space-3); margin: var(--space-6) 0; font-size: var(--text-sm); color: var(--muted-foreground); }
.import-steps li { display: flex; align-items: center; gap: var(--space-2); flex: 1; }
.import-steps li:not(:last-child)::after { content: ''; height: 1px; flex: 1; background: var(--border); margin-left: var(--space-2); }
.import-steps li:last-child { flex: 0 0 auto; }
.import-steps [aria-current] { color: var(--foreground); }
.step-number { width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border); display: inline-flex; align-items: center; justify-content: center; flex: none; }
[aria-current] .step-number, [data-complete="true"] .step-number { color: var(--primary-ink); border-color: var(--primary); background: var(--primary-soft); }
.import-content { display: grid; gap: var(--space-5); min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.import-content p { margin: 0; }
.source-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); border: 0; padding: 0; margin: 0; min-width: 0; }
.source-option.ui-button { height: auto; min-height: 80px; justify-content: flex-start; gap: var(--space-3); padding: var(--space-4); text-align: left; white-space: normal; }
.source-option span { display: grid; gap: var(--space-1); }
.source-option strong { font-weight: var(--weight-medium); }
.source-option small { font-size: var(--text-sm); color: var(--muted-foreground); }
.import-field { display: grid; gap: var(--space-2); font-size: var(--text-md); }
.import-help { color: var(--muted-foreground); font-size: var(--text-sm); line-height: var(--leading-normal); overflow-wrap: anywhere; }
.import-source { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border-radius: var(--control-lg-radius); background: var(--muted); font-size: var(--text-md); }
.import-source > svg { flex: none; color: var(--muted-foreground); }
.import-source > div { flex: 1; min-width: 0; }
.import-source strong { display: block; font-weight: var(--weight-medium); }
.import-source code { display: block; margin-top: var(--space-1); font-size: var(--text-xs); color: var(--muted-foreground); overflow-wrap: anywhere; }
.format-options summary { display: flex; align-items: center; gap: var(--space-2); cursor: pointer; color: var(--fg-2); font-size: var(--text-sm); }
.format-options .import-field { margin-block: var(--space-3); }
.selection-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); font-size: var(--text-md); }
.selection-heading strong { font-weight: var(--weight-medium); }
.selection-heading span { color: var(--muted-foreground); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
.import-ledger { margin-top: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
.entry-group + .entry-group { border-top: 1px solid var(--border); }
.entry-group[data-expanded="true"] { background: var(--muted); }
.import-row { display: flex; align-items: flex-start; gap: var(--space-3); min-height: 64px; padding: var(--space-4); }
.import-row > .ui-check { margin-top: var(--space-1); flex: none; }
.entry-identity { flex: 1; min-width: 0; }
.entry-identity > div { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--space-2); }
.entry-identity strong { font: var(--weight-medium) var(--text-md) var(--font-mono); overflow-wrap: anywhere; }
.entry-identity span, .entry-identity small { color: var(--muted-foreground); font-size: var(--text-xs); }
.entry-identity small { display: block; margin-top: var(--space-1); overflow-wrap: anywhere; line-height: var(--leading-normal); }
.entry-status { color: var(--muted-foreground); font-size: var(--text-xs); padding-top: var(--space-1); white-space: nowrap; }
.entry-status[data-new="true"] { color: var(--primary-ink); }
.entry-resolution { padding: 0 var(--space-4) var(--space-4) var(--space-12); display: grid; gap: var(--space-3); }
.resolution-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); font-size: var(--text-sm); color: var(--fg-2); }
.rename-field { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-3); font-size: var(--text-sm); color: var(--fg-2); }
.import-empty { padding-block: var(--space-6); color: var(--muted-foreground); font-size: var(--text-md); }
.import-destination { display: grid; gap: var(--space-2); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.import-destination > div { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.import-destination strong { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.import-destination > div > button { margin-left: auto; }
.import-destination p { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-xs); color: var(--muted-foreground); }
.ui-dialog-footer { margin-top: var(--space-5); }
.cancel-import { margin-right: auto; }
.confirmation h3 { margin: 0 0 var(--space-2); font-size: var(--text-base); font-weight: var(--weight-medium); }
.confirmation ul { list-style: none; padding: 0; margin: var(--space-4) 0 0; border-block: 1px solid var(--border); }
.confirmation li { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); padding-block: var(--space-3); font-size: var(--text-sm); }
.confirmation li + li { border-top: 1px solid var(--border); }
.confirmation code { overflow-wrap: anywhere; }
.confirmation li > span { flex: none; color: var(--muted-foreground); }
.confirmation .replace-warning { color: var(--warning); }
.import-complete { padding-block: var(--space-4); }
.import-complete > svg { color: var(--primary-ink); margin-bottom: var(--space-3); }
.import-complete p { color: var(--fg-2); font-size: var(--text-md); line-height: var(--leading-normal); }
.stale-message { flex-wrap: wrap; }
.source-reselect { display: grid; gap: var(--space-2); }
.source-reselect > div { display: flex; gap: var(--space-3); }
@media (max-width: 719.98px) { .mcp-import { max-height: 90dvh; }.import-row { gap: var(--space-2); padding: var(--space-3); }.entry-resolution { padding-left: var(--space-3); }.source-options { grid-template-columns: minmax(0, 1fr); }.source-option.ui-button { min-height: 64px; }.entry-status { white-space: normal; max-width: 72px; }.ui-dialog-footer { flex-wrap: wrap; }.import-source { flex-wrap: wrap; } }
</style>
