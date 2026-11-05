import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import test from "node:test"
import { compileScript, parse } from "vue/compiler-sfc"
import { createRenderer, h, nextTick, reactive } from "vue"

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("McpSettings.vue") || context.parentURL?.endsWith("McpImport.vue")) {
      if (specifier === "../../stores/connection") return { url: "data:text/javascript,export const useConnectionStore=()=>globalThis.settingsConnection", shortCircuit: true }
      if (specifier === "../../stores/sessions") return { url: "data:text/javascript,export const useSessionsStore=()=>({workspaces:[{cwd:'/project',name:'Project'}]})", shortCircuit: true }
    }
    if (specifier === "vue-i18n") return { url: "data:text/javascript,export const useI18n=()=>({locale:{value:'en'}})", shortCircuit: true }
    if (specifier.endsWith(".vue") && !/Mcp(?:Settings|Import)\.vue$/.test(specifier)) return { url: "data:text/javascript,export default { props:['busy','error','saved'], emits:['reload'], setup(props){return ()=>props.error||null} }", shortCircuit: true }
    try { return next(specifier, context) } catch (error) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.(ts|vue)$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  },
  load(url, context, next) {
    if (url.endsWith(".ts")) return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }), shortCircuit: true }
    if (!/Mcp(?:Settings|Import)\.vue$/.test(url)) return next(url, context)
    const { descriptor } = parse(readFileSync(new URL(url), "utf8"))
    return { format: "module", source: stripTypeScriptTypes(compileScript(descriptor, { id: "settings-mcp-test", inlineTemplate: true }).content, { mode: "transform" }), shortCircuit: true }
  },
})

globalThis.Document = class {}
globalThis.ShadowRoot = class {}

const { readMcp, readMcpConfiguration, readMcpImportApplied, readMcpImportPreview } = await import("../src/rpc/general-settings.ts")
const { RpcError } = await import("../src/rpc/client.ts")
const { default: McpSettings } = await import("../src/features/settings/McpSettings.vue")
const { default: McpImport } = await import("../src/features/settings/McpImport.vue")
const { MAX_IMPORT_BYTES } = await import("../src/features/settings/mcp-adapters.ts")

const node = (type, text = "") => ({
  type, text, children: [], props: {}, parent: undefined, value: "", options: [], selectedIndex: -1, listeners: {}, open: false,
  addEventListener(name, handler) { this.listeners[name] = handler },
  reportValidity: () => true, getRootNode() { return {} },
  showModal() { this.open = true }, close() { this.open = false },
  click() { this.clicks = (this.clicks ?? 0) + 1 }, focus() {},
})
const body = node("body")
const renderer = createRenderer({
  querySelector: (selector) => selector === "body" ? body : undefined,
  createElement: type => node(type), createText: (text) => node("text", text), createComment: (text) => node("comment", text),
  patchProp: (element, key, _, value) => { element.props[key] = key === "disabled" ? value === "" || Boolean(value) : value },
  setText: (element, text) => { element.text = text },
  setElementText: (element, text) => { element.text = text; element.children = [] },
  parentNode: (element) => element.parent,
  nextSibling: (element) => element.parent?.children[element.parent.children.indexOf(element) + 1],
  insert(element, parent, anchor) {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1)
    parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, element)
    element.parent = parent
  },
  remove(element) {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1)
    element.parent = undefined
  },
})
const text = (element) => (element.type === "comment" ? "" : element.text) + element.children.map(text).join("")
const all = (element) => [element, ...element.children.flatMap(all)]
const flush = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
const button = (root, label) => all(root).find((element) => element.type === "button" && text(element) === label)
const field = (root, label) => all(root).find((element) => element.type === "label" && text(element).startsWith(label)).children.find((element) => element.type === "input" || element.type === "select")
const enter = (element, value) => {
  if (element.props["onUpdate:modelValue"]) element.props["onUpdate:modelValue"](value)
  else element.props.onChange({ target: { value } })
}
const submit = (root) => all(root).find((element) => element.type === "form" && text(element).includes("Save server")).props.onSubmit({ preventDefault() {} })

function catalog(invalid) {
  return {
    userRevision: "user:1", projectRevision: null,
    userApplication: { error: null, cleanupError: null }, pluginApplication: null, projectApplication: null,
    servers: [{ id: "docs", source: "user", enabled: true, transport: "stdio" }],
    ...(invalid === undefined ? {} : { invalid }),
  }
}

test("a broken entry is read apart from the servers", () => {
  const error = "MCP server broken: field type must be http or sse; ws is not a supported transport"
  const view = readMcp(catalog([{ id: "broken", source: "project", error }]))
  assert.deepEqual(view.servers.map((server) => server.id), ["docs"])
  assert.deepEqual(view.invalid, [{ id: "broken", source: "project", error }])
})

test("a reply without the invalid list still reads its servers", () => {
  const view = readMcp(catalog(undefined))
  assert.deepEqual(view.servers.map((server) => server.id), ["docs"])
  assert.deepEqual(view.invalid, [])
})

test("settings show referenced and unset variable names", () => {
  const view = readMcp({
    ...catalog(undefined),
    servers: [{ id: "docs", source: "user", enabled: true, transport: "http",
      referencedVariables: ["MCP_HOST", "MCP_TOKEN"], unsetVariables: ["MCP_TOKEN"] }],
  })
  assert.deepEqual(view.servers[0].referencedVariables, ["MCP_HOST", "MCP_TOKEN"])
  assert.deepEqual(view.servers[0].unsetVariables, ["MCP_TOKEN"])
  const legacy = readMcp(catalog(undefined))
  assert.deepEqual(legacy.servers[0].referencedVariables, [])
  assert.deepEqual(legacy.servers[0].unsetVariables, [])
})

test("a configuration view names variables without values", () => {
  const configuration = readMcpConfiguration({
    type: "http", endpoint: "https://${MCP_HOST}", headerNames: ["Authorization"],
    authConfigured: true, oauthConfigured: false, oauth: null,
    referencedVariables: ["MCP_HOST", "MCP_TOKEN"], unsetVariables: ["MCP_TOKEN"],
  })
  assert.deepEqual(configuration.referencedVariables, ["MCP_HOST", "MCP_TOKEN"])
  assert.deepEqual(configuration.unsetVariables, ["MCP_TOKEN"])
  const legacy = readMcpConfiguration({ type: "stdio", command: "server", argsCount: 0, cwd: null, envNames: [] })
  assert.deepEqual(legacy.referencedVariables, [])
  assert.deepEqual(legacy.unsetVariables, [])
})

const { configuration, patch } = await import("../src/features/settings/mcp-form.ts")

function draft(overrides) {
  return {
    id: "docs", source: "user", type: "stdio", command: "server", args: [], cwd: "",
    argsAction: "replace", storedArgsCount: 0, secrets: [], enabled: false, token: "",
    authConfigured: false, bearerAction: "keep", oauth: false, oauthAction: "keep",
    clientId: "", callbackPort: "", scopes: "", metadataUrl: "", timeout: "",
    metadataConfigured: false, metadataAction: "keep", secretsInUserScope: false,
    ...overrides,
  }
}

test("a number-typed timeout saves and tests as the number", () => {
  const typed = draft({ timeout: 5000 })
  assert.equal(configuration(typed).timeout, 5000)
  assert.equal(patch(typed).timeout, 5000)
  const remote = draft({ type: "http", url: "https://example.test/mcp", timeout: 5000 })
  assert.equal(configuration(remote).timeout, 5000)
  assert.equal(patch(remote).timeout, 5000)
})

test("a kept string timeout still saves as the number", () => {
  const typed = draft({ timeout: "5000" })
  assert.equal(configuration(typed).timeout, 5000)
  assert.equal(patch(typed).timeout, 5000)
  const blank = draft({ timeout: "" })
  assert.equal("timeout" in configuration(blank), false)
  assert.equal(patch(blank).timeout, null)
})

/// #952: the daemon expands a reference, so the form accepts an endpoint
/// template and a malformed literal endpoint still stops the save.
test("an endpoint template is a valid draft and a malformed literal URL is not", async () => {
  const saves = []
  globalThis.window = { confirm: () => true }
  globalThis.settingsConnection = reactive({
    phase: "connected",
    supports: () => true,
    client: { call: async (method, params, read) => {
      if (method === "mcp.catalog") return read(catalog(undefined))
      assert.equal(method, "mcp.save")
      saves.push(JSON.parse(JSON.stringify(params)))
      return read({})
    } },
  })
  const root = node("root")
  const app = renderer.createApp(McpSettings)
  app.mount(root)
  try {
    await flush()
    await button(root, "Add server").props.onClick()
    await flush()
    enter(field(root, "Server ID"), "template")
    enter(field(root, "Transport"), "http")
    await flush()
    const url = field(root, "URL")
    assert.equal(url.props.type, "text")
    assert.equal(url.props.inputmode, "url")
    enter(url, "${MCP_URL}/mcp")
    await flush()
    await submit(root)
    await flush()
    assert.equal(saves.length, 1)
    assert.equal(saves[0].configuration.type, "http")
    assert.equal(saves[0].configuration.url, "${MCP_URL}/mcp")

    await button(root, "Add server").props.onClick()
    await flush()
    enter(field(root, "Server ID"), "broken")
    enter(field(root, "Transport"), "http")
    await flush()
    enter(field(root, "URL"), "not a url")
    await flush()
    await submit(root)
    await flush()
    assert.equal(saves.length, 1, "the malformed literal URL never reaches the daemon")
    assert.match(text(root), /The endpoint must be an absolute URL/)
  } finally {
    app.unmount()
    delete globalThis.settingsConnection
    delete globalThis.window
  }
})

test("changing MCP scope keeps cancelled or failed drafts and saves only to the loaded workspace", async t => {
  let fail = false
  const saves = []
  globalThis.window = { confirm: () => true }
  globalThis.settingsConnection = reactive({
    phase: "connected", supports: () => true,
    client: { call: async (method, params, read) => {
      if (method === "mcp.catalog") {
        if (fail) throw new Error("project unavailable")
        return read({ ...catalog(undefined), projectRevision: params.cwd ? "project:1" : null })
      }
      assert.equal(method, "mcp.save")
      saves.push(params)
      return read({})
    } },
  })
  const root = node("root"), app = renderer.createApp(McpSettings)
  app.mount(root)
  t.after(() => { app.unmount(); delete globalThis.settingsConnection; delete globalThis.window })
  await flush()
  await button(root, "Add server").props.onClick(); await flush()
  enter(field(root, "Server ID"), "new-server")
  enter(field(root, "Executable"), "server"); await flush()
  const scope = field(root, "Configuration scope")
  globalThis.window.confirm = () => false
  const cancelled = { value: "/project" }
  await scope.props.onChange({ target: cancelled }); await flush()
  assert.equal(cancelled.value, "")
  assert.ok(button(root, "Save server"))
  globalThis.window.confirm = () => true
  fail = true
  const failed = { value: "/project" }
  await scope.props.onChange({ target: failed }); await flush()
  assert.equal(failed.value, "")
  assert.match(text(root), /project unavailable/)
  await submit(root); await flush()
  assert.equal(saves[0].cwd, undefined)
  fail = false
  await scope.props.onChange({ target: { value: "/project" } }); await flush()
  await button(root, "Add server").props.onClick(); await flush()
  enter(field(root, "Server ID"), "project-server")
  enter(field(root, "Executable"), "server")
  enter(field(root, "Source"), "project"); await flush()
  await submit(root); await flush()
  assert.equal(saves[1].cwd, "/project")
  assert.equal(saves[1].source, "project")
  assert.equal(saves[1].expectedVersion, "project:1")
})

const importEntry = (overrides) => ({ id: "docs", transport: "stdio", status: "changed", changes: [], unsupported: [], omitted: 0, ...overrides })
const importPreviewReply = (entries = [importEntry()], revision = "user:1", unknownTopLevel = []) => ({ revision, entries, unknownTopLevel })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const inputNamed = (root, name) => all(root).find(element => element.type === "input" && element.props["aria-label"] === name)
const actionNamed = (root, name) => all(root).find(element => element.type === "button" && element.props["aria-label"] === name)
const dialogOf = (root) => all(root).find(element => element.type === "dialog")
const importCalls = (calls, suffix) => calls.filter(call => call.method === `mcp.import.${suffix}`)
const readSelected = (root, id, selected = true) => {
  const input = inputNamed(root, `Select ${id}`)
  assert.ok(input, `select ${id}`)
  assert.equal(input.props.disabled, false)
  input.props["onUpdate:modelValue"](selected)
  input.props.onChange({ target: { checked: selected } })
}
async function mountImport(t, { preview = importPreviewReply(), catalogs = [catalog()], apply, inspect, supports = () => true, standalone = false, refresh = async () => {}, ancestorDisabled = false } = {}) {
  const calls = []
  let served = 0
  const connection = reactive({
    phase: "connected", supports,
    client: { call: async (method, params, read) => {
      calls.push({ method, params })
      if (method === "mcp.catalog") {
        const reply = catalogs[Math.min(served++, catalogs.length - 1)]
        return read(typeof reply === "function" ? await reply(params) : await reply)
      }
      if (method === "mcp.inspect") return read(await inspect(params))
      if (method === "mcp.import.preview") return read(typeof preview === "function" ? await preview(params) : preview)
      if (method === "mcp.import.apply") return read(apply ? await apply(params) : { revision: "user:2" })
      throw new Error(`unexpected method ${method}`)
    } },
  })
  globalThis.settingsConnection = connection
  globalThis.window = { confirm: () => { throw new Error("Import must use the native step confirmation, not window.confirm") } }
  const root = node("root")
  const view = node("document")
  view.children = [root, body]
  const props = reactive({ cwd: "", disabled: false, refresh })
  const busyEvents = []
  const app = renderer.createApp(standalone ? { render: () => h("form", { onSubmit: () => assert.fail("dialog controls submitted the ancestor form") }, [h("fieldset", { disabled: ancestorDisabled }, [h(McpImport, { ...props, onBusy: value => busyEvents.push(value) })])]) } : McpSettings)
  app.mount(root)
  t.after(() => { app.unmount(); delete globalThis.settingsConnection; delete globalThis.window })
  await flush()
  return { root: view, settingsRoot: root, app, calls, connection, props, busyEvents }
}
async function openImport(root) {
  await button(root, "Import…").props.onClick()
  await flush()
  assert.equal(dialogOf(root).open, true)
}
async function chooseFile(root, contents = "{}", name = "config.json") {
  const file = typeof contents === "string" ? new File([contents], name, { type: "application/json" }) : contents
  const input = inputNamed(root, "Import configuration file")
  const target = { files: [file], value: "selected" }
  await input.props.onChange({ target })
  assert.equal(target.value, "")
  await flush()
  return file
}
async function previewFile(root, contents = "{}", name = "config.json") {
  await openImport(root)
  const file = await chooseFile(root, contents, name)
  await button(root, "Preview configuration").props.onClick()
  await flush()
  return file
}
async function confirmSelection(root, ids) {
  for (const id of ids) readSelected(root, id)
  await flush()
  await button(root, `Next · review ${ids.length}`).props.onClick()
  await flush()
  assert.ok(button(root, `Confirm import ${ids.length}`))
}

test("native import requires selection and final confirmation and shows every safe metadata field", async t => {
  const secret = "sk-web-secret-never-print"
  const document = JSON.stringify({ mcpServers: { docs: { command: "server", env: { TOKEN: secret } } } })
  const preview = importPreviewReply([
    importEntry({ id: "keeps", status: "identical" }),
    importEntry({ changes: [{ field: "args", kind: "array" }, { field: "enabled", kind: "boolean" }], unsupported: [{ field: "x-extra", effect: "kept-unused" }], omitted: 7 }),
    importEntry({ id: "taken", transport: "http", status: "conflict" }),
    importEntry({ id: "broken", status: "invalid", transport: undefined, error: "Unsupported transport", unsupported: [{ field: "auth.audience", effect: "dropped" }] }),
  ], "user:1", ["otherTopLevel"])
  const { root, settingsRoot, calls } = await mountImport(t, { preview })
  await previewFile(root, document)
  assert.equal(importCalls(calls, "apply").length, 0)
  assert.equal(button(root, "Next · review 0").props.disabled, true)
  assert.ok(all(root).filter(element => element.type === "input" && element.props.type === "checkbox").every(element => !element.checked))
  assert.equal(inputNamed(root, "Select broken").props.disabled, true)
  assert.equal(actionNamed(root, "Actions for broken"), undefined)
  assert.match(text(root), /Identical/)
  assert.match(text(root), /Changed/)
  assert.match(text(root), /Same ID/)
  assert.match(text(root), /Not importable/)
  assert.match(text(root), /args \(array\), enabled \(boolean\)/)
  assert.match(text(root), /x-extra \(kept-unused\)/)
  assert.match(text(root), /auth\.audience \(dropped\)/)
  assert.match(text(root), /7 more field names are not listed/)
  assert.match(text(root), /otherTopLevel/)
  assert.match(text(root), /Unsupported transport/)
  assert.equal(text(root).includes(secret), false)
  assert.equal(all(settingsRoot).some(element => element.type === "dialog"), false)
  assert.equal(dialogOf(root).parent, body)
  assert.deepEqual(importCalls(calls, "preview")[0].params, { source: "user", document })
  await confirmSelection(root, ["keeps", "docs"])
  assert.equal(importCalls(calls, "apply").length, 0)
  assert.equal(button(root, "Confirm import 2").props.type, "button")
  await button(root, "Confirm import 2").props.onClick(); await flush()
  assert.deepEqual(importCalls(calls, "apply")[0].params, {
    source: "user", document, expectedVersion: "user:1",
    resolutions: [{ id: "keeps", action: "import" }, { id: "docs", action: "import" }, { id: "taken", action: "skip" }, { id: "broken", action: "skip" }],
  })
  assert.match(text(root), /Imported 1, replaced 0, renamed 0, skipped 2, unchanged 1/)
  assert.match(text(root), /Written target IDs: docs/)
  assert.match(text(root), /Identical entries keep their enabled state/)
  assert.equal(text(root).includes(secret), false)
  assert.equal(calls.filter(call => call.method === "mcp.catalog").length, 2)
})

test("one resolver expands at a time; rename and explicit replacement use native resolutions", async t => {
  const { root, calls } = await mountImport(t, { preview: importPreviewReply([importEntry(), importEntry({ id: "taken", status: "conflict" })]) })
  await previewFile(root)
  readSelected(root, "taken"); await flush()
  await button(root, "Next · review 1").props.onClick(); await flush()
  assert.match(text(root), /Resolve each target conflict/)
  assert.equal(button(root, "Confirm import 1"), undefined)
  await actionNamed(root, "Actions for docs").props.onClick(); await flush()
  assert.equal(all(root).filter(element => element.props.class === "entry-resolution").length, 1)
  assert.equal(button(root, "Replace"), undefined)
  await button(root, "Rename").props.onClick(); await flush()
  enter(field(root, "Target ID"), "docs2"); await flush()
  await actionNamed(root, "Actions for taken").props.onClick(); await flush()
  assert.equal(all(root).filter(element => element.props.class === "entry-resolution").length, 1)
  await button(root, "Replace").props.onClick(); await flush()
  await button(root, "Next · review 2").props.onClick(); await flush()
  assert.match(text(root), /Replace target/)
  await button(root, "Confirm import 2").props.onClick(); await flush()
  assert.deepEqual(importCalls(calls, "apply")[0].params.resolutions, [{ id: "docs", action: "rename", newId: "docs2" }, { id: "taken", action: "replace" }])
  assert.match(text(root), /Imported 0, replaced 1, renamed 1, skipped 0, unchanged 0/)
})

test("rename targets must be nonempty and unique before confirmation", async t => {
  const { root, calls } = await mountImport(t, { preview: importPreviewReply([importEntry(), importEntry({ id: "second" })]) })
  await previewFile(root)
  for (const id of ["docs", "second"]) {
    await actionNamed(root, `Actions for ${id}`).props.onClick(); await flush()
    await button(root, "Rename").props.onClick(); await flush()
    enter(field(root, "Target ID"), "same"); await flush()
  }
  await button(root, "Next · review 2").props.onClick(); await flush()
  assert.match(text(root), /nonempty and unique/)
  enter(field(root, "Target ID"), " "); await flush()
  await button(root, "Next · review 2").props.onClick(); await flush()
  assert.equal(button(root, "Confirm import 2"), undefined)
  assert.equal(importCalls(calls, "apply").length, 0)
})

test("workspace selection is retained and project import confirms its destination", async t => {
  const { root, calls } = await mountImport(t, { catalogs: [{ ...catalog(), projectRevision: "project:1" }], preview: importPreviewReply([importEntry()], "project:1") })
  assert.match(text(field(root, "Configuration scope")), /Project — \/project/)
  await field(root, "Configuration scope").props.onChange({ target: { value: "/project" } }); await flush()
  await previewFile(root)
  assert.match(text(root), /Project · \/project/)
  assert.match(text(root), /hidden values stay in user storage/)
  await confirmSelection(root, ["docs"])
  assert.equal(importCalls(calls, "apply").length, 0)
  await button(root, "Confirm import 1").props.onClick(); await flush()
  assert.equal(importCalls(calls, "apply")[0].params.cwd, "/project")
  assert.equal(importCalls(calls, "apply")[0].params.source, "project")
  assert.equal(importCalls(calls, "apply")[0].params.expectedVersion, "project:1")
})

test("busy lasts through delayed catalog and detail refresh, preventing duplicate apply and dismissal", async t => {
  const catalogRefresh = deferred(), detailRefresh = deferred()
  let inspected = 0
  const inspection = { enabled: false, configuration: { type: "stdio", command: "server", argsCount: 0, envNames: [] }, connections: [] }
  const { root, calls } = await mountImport(t, {
    catalogs: [catalog(), catalogRefresh.promise],
    inspect: () => inspected++ === 0 ? inspection : detailRefresh.promise,
  })
  await button(root, "Details / tools").props.onClick(); await flush()
  await previewFile(root)
  await confirmSelection(root, ["docs"])
  const applyClick = button(root, "Confirm import 1").props.onClick
  const pending = applyClick(); await flush()
  assert.equal(button(root, "Done").props.disabled, true)
  assert.equal(button(root, "Load / refresh").props.disabled, true)
  assert.equal(field(root, "Configuration scope").props.disabled, true)
  await applyClick(); await flush()
  const dialog = dialogOf(root)
  dialog.props.onCancel({ target: dialog, currentTarget: dialog, preventDefault() {} })
  assert.equal(dialog.open, true)
  catalogRefresh.resolve(catalog()); await flush()
  assert.equal(button(root, "Done").props.disabled, true)
  detailRefresh.resolve(inspection)
  await pending; await flush()
  assert.equal(button(root, "Done").props.disabled, false)
  assert.equal(button(root, "Load / refresh").props.disabled, false)
  assert.equal(importCalls(calls, "apply").length, 1)
  assert.equal(inspected, 2)
})

test("refresh failure keeps truthful import outcome and names the recovery action", async t => {
  const { root } = await mountImport(t, { catalogs: [catalog(), () => { throw new Error("unavailable") }] })
  await previewFile(root)
  await confirmSelection(root, ["docs"])
  await button(root, "Confirm import 1").props.onClick(); await flush()
  assert.match(text(root), /Import complete/)
  assert.match(text(root), /Catalog refresh failed. Reload the catalog/)
  assert.equal(button(root, "Done").props.disabled, false)
})

test("partial RPC errors name accepted targets for review and only report known no-op and skip rows", async t => {
  const { root, calls } = await mountImport(t, {
    preview: importPreviewReply([importEntry(), importEntry({ id: "taken", status: "conflict" }), importEntry({ id: "copy" }), importEntry({ id: "keeps", status: "identical" }), importEntry({ id: "skipped" })]),
    apply: () => { throw new RpcError(-32000, "partial", "mcp_import_partial") },
  })
  await previewFile(root)
  readSelected(root, "docs"); readSelected(root, "keeps")
  await actionNamed(root, "Actions for taken").props.onClick(); await flush()
  await button(root, "Replace").props.onClick(); await flush()
  await actionNamed(root, "Actions for copy").props.onClick(); await flush()
  await button(root, "Rename").props.onClick(); await flush()
  enter(field(root, "Target ID"), "copy2"); await flush()
  await button(root, "Next · review 4").props.onClick(); await flush()
  await button(root, "Confirm import 4").props.onClick(); await flush()
  assert.match(text(root), /Accepted target IDs needing review: docs, taken, copy2/)
  assert.match(text(root), /Unchanged entries: keeps/)
  assert.match(text(root), /Skipped entries: skipped/)
  assert.doesNotMatch(text(root), /Import complete|Written target IDs|Imported \d/)
  assert.equal(button(root, "Next · review 4").props.disabled, true)
  assert.equal(calls.filter(call => call.method === "mcp.catalog").length, 2)
  await button(root, "Refresh preview").props.onClick(); await flush()
  assert.equal(button(root, "Next · review 0").props.disabled, true)
})

test("stale target preview reuses the immutable document and requires renewed selections", async t => {
  const document = '{"mcpServers":{"docs":{"command":"server"}}}'
  let previews = 0
  const { root, calls } = await mountImport(t, {
    preview: () => importPreviewReply([importEntry()], `user:${++previews}`),
    apply: () => { throw new RpcError(-32000, "changed", "mcp_settings_conflict") },
  })
  await previewFile(root, document)
  await confirmSelection(root, ["docs"])
  await button(root, "Confirm import 1").props.onClick(); await flush()
  assert.match(text(root), /source changed since this preview/)
  assert.equal(button(root, "Next · review 1").props.disabled, true)
  await button(root, "Refresh preview").props.onClick(); await flush()
  assert.equal(importCalls(calls, "preview").length, 2)
  assert.equal(importCalls(calls, "preview")[1].params.document, document)
  assert.equal(button(root, "Next · review 0").props.disabled, true)
  await confirmSelection(root, ["docs"])
  await button(root, "Confirm import 1").props.onClick(); await flush()
  assert.equal(importCalls(calls, "apply")[1].params.expectedVersion, "user:2")
})

test("changed disk content requires explicitly reacquiring a distinct File snapshot", async t => {
  const { root, calls } = await mountImport(t)
  const before = new File(['{"mcpServers":{"before":{}}}'], "config.json")
  const after = new File(['{"mcpServers":{"after":{}}}'], "config.json")
  await previewFile(root, before)
  assert.match(text(root), /Changed the file on disk\? Re-select/)
  await button(root, "Back").props.onClick(); await flush()
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.equal(importCalls(calls, "preview")[1].params.document, await before.text())
  await button(root, "Re-select file").props.onClick(); await flush()
  assert.equal(inputNamed(root, "Import configuration file").clicks, 1)
  await chooseFile(root, after)
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.equal(importCalls(calls, "preview")[2].params.document, await after.text())
  assert.equal(importCalls(calls, "preview")[0].params.document, await before.text())
})

test("unreadable File snapshots offer explicit reacquisition, and picker cancellation preserves the dialog", async t => {
  const { root, calls } = await mountImport(t)
  await openImport(root)
  const unreadable = new File(["{}"], "config.json")
  Object.defineProperty(unreadable, "text", { value: async () => { throw new DOMException("gone", "NotReadableError") } })
  await chooseFile(root, unreadable)
  assert.match(text(root), /Re-select the file or folder to acquire a fresh browser snapshot/)
  assert.ok(button(root, "Re-select file"))
  assert.ok(button(root, "Re-select folder"))
  const dialog = dialogOf(root), input = inputNamed(root, "Import configuration file")
  let prevented = false
  dialog.props.onCancel({ target: input, currentTarget: dialog, preventDefault() { prevented = true } })
  assert.equal(prevented, false)
  assert.equal(dialog.open, true)
  await input.props.onChange({ target: { files: [], value: "" } }); await flush()
  assert.equal(dialog.open, true)
  assert.equal(importCalls(calls, "preview").length, 0)
  await button(root, "Re-select file").props.onClick()
  await chooseFile(root, new File(["{}"], "config.json"))
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.equal(importCalls(calls, "preview").length, 1)
})

test("cancel and queued native close events cannot revive or close a newly opened import", async t => {
  const { root, calls } = await mountImport(t)
  await previewFile(root)
  await confirmSelection(root, ["docs"])
  await button(root, "Cancel").props.onClick(); await flush()
  assert.equal(dialogOf(root).open, false)
  assert.equal(importCalls(calls, "apply").length, 0)
  await openImport(root)
  dialogOf(root).props.onClose(); await flush()
  assert.equal(dialogOf(root).open, true)
  assert.ok(button(root, "Preview configuration"))
  assert.equal(button(root, "Preview configuration").props.disabled, true)
})

test("offline dialog dismissal invalidates late preview and apply replies", async t => {
  for (const stage of ["preview", "apply"]) {
    await t.test(stage, async t => {
      const pending = deferred()
      const { root, connection, calls } = await mountImport(t, {
        preview: stage === "preview" ? () => pending.promise : importPreviewReply(),
        apply: stage === "apply" ? () => pending.promise : undefined,
      })
      await openImport(root); await chooseFile(root)
      let request = button(root, "Preview configuration").props.onClick(); await flush()
      if (stage === "apply") {
        await request
        await confirmSelection(root, ["docs"])
        request = button(root, "Confirm import 1").props.onClick(); await flush()
      }
      connection.phase = "reconnecting"; await flush()
      assert.equal(button(root, "Cancel").props.disabled, false)
      await button(root, "Cancel").props.onClick(); await flush()
      pending.resolve(stage === "preview" ? importPreviewReply() : { revision: "user:2" })
      await request; await flush()
      assert.equal(dialogOf(root).open, false)
      assert.doesNotMatch(text(root), /Import complete|Select servers/)
      assert.equal(calls.filter(call => call.method === "mcp.catalog").length, 1)
    })
  }
})

test("scope generation changes discard a pending preview and keep the next request in the new scope", async t => {
  const pending = deferred()
  let previews = 0
  const { root, props, calls } = await mountImport(t, { standalone: true, preview: () => ++previews === 1 ? pending.promise : importPreviewReply() })
  await openImport(root); await chooseFile(root)
  const request = button(root, "Preview configuration").props.onClick(); await flush()
  props.cwd = "/other"; await flush()
  pending.resolve(importPreviewReply([importEntry({ id: "obsolete" })]))
  await request; await flush()
  assert.doesNotMatch(text(root), /obsolete/)
  assert.ok(button(root, "Preview configuration"))
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.equal(importCalls(calls, "preview")[1].params.cwd, "/other")
})

test("missing preview or apply methods disable the only import entrypoint", async t => {
  for (const missing of ["mcp.import.preview", "mcp.import.apply"]) {
    await t.test(missing, async t => {
      const { root, calls } = await mountImport(t, { supports: method => method !== missing })
      assert.equal(button(root, "Import…").props.disabled, true)
      assert.match(button(root, "Import…").props.title, /does not support MCP import/)
      await button(root, "Import…").props.onClick(); await flush()
      assert.equal(dialogOf(root).open, false)
      assert.equal(importCalls(calls, "preview").length, 0)
      assert.equal(button(root, "Import from file…"), undefined)
    })
  }
})

test("native missing-method and validation errors remain visible without applying or exposing content", async t => {
  for (const failure of [new RpcError(-32601, "Method not found", undefined), new RpcError(-32000, "Invalid MCP document", "mcp_invalid_config")]) {
    await t.test(failure.message, async t => {
      const { root, calls } = await mountImport(t, { preview: () => { throw failure } })
      await previewFile(root, '{"mcpServers":{"docs":{"command":"server","env":{"TOKEN":"hidden-value"}}}}')
      assert.match(text(root), new RegExp(failure.message))
      assert.equal(text(root).includes("hidden-value"), false)
      assert.equal("format" in importCalls(calls, "preview")[0].params, false)
      assert.equal(importCalls(calls, "apply").length, 0)
    })
  }
})

test("empty, oversized, and empty-preview configurations cannot be imported", async t => {
  const { root, calls } = await mountImport(t, { preview: importPreviewReply([]) })
  await openImport(root)
  await chooseFile(root, "  ")
  assert.match(text(root), /selected file is empty/)
  assert.equal(button(root, "Preview configuration").props.disabled, true)
  await chooseFile(root, new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "config.json"))
  assert.match(text(root), /8 MiB import limit/)
  assert.equal(importCalls(calls, "preview").length, 0)
  await chooseFile(root)
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.match(text(root), /contains no MCP server entries/)
  assert.equal(button(root, "Next · review 0").props.disabled, true)
})

const clientDocuments = {
  json: JSON.stringify({ mcpServers: { docs: { command: "server-json" } } }),
  codex: '[mcp_servers.docs]\ncommand = "server-codex"\n',
  omp: JSON.stringify({ mcpServers: { docs: { command: "server-omp" } } }),
  qoder: JSON.stringify({ mcpServers: { docs: { command: "server-qoder", disabled: true } } }),
  kimi: JSON.stringify({ mcpServers: { docs: { command: "server-kimi" } } }),
  cursor: JSON.stringify({ mcpServers: { docs: { command: "server-cursor" } } }),
  gemini: JSON.stringify({ mcpServers: { docs: { command: "server-gemini" } } }),
  vscode: JSON.stringify({ servers: { docs: { type: "stdio", command: "server-vscode" } } }),
  opencode: JSON.stringify({ mcp: { docs: { type: "local", command: ["server-opencode"] } } }),
}

test("explicit arbitrary file formats and all nine client paths use the same document protocol", async t => {
  const paths = [
    ["root/.mcp.json", "json"], ["root/.claude.json", "json"], ["root/.codeium/windsurf/mcp_config.json", "json"], ["root/.copilot/mcp-config.json", "json"],
    ["root/.codex/config.toml", "codex"], ["root/.omp/mcp.json", "omp"], ["root/.omp/.mcp.json", "omp"], ["root/.omp/agent/.mcp.json", "omp"], ["root/.omp/agent/mcp.json", "omp"], ["root/.omp/profiles/test/agent/mcp.json", "omp"],
    ["root/.qoder/settings.json", "qoder"], ["root/.qoder/settings.local.json", "qoder"], ["root/.kimi/mcp.json", "kimi"], ["root/.kimi-code/mcp.json", "kimi"],
    ["root/.cursor/mcp.json", "cursor"], ["root/.gemini/settings.json", "gemini"], ["root/.vscode/mcp.json", "vscode"], ["root/opencode.json", "opencode"], ["root/opencode.jsonc", "opencode"],
  ].sort(([left], [right]) => left.localeCompare(right))
  const { root, calls } = await mountImport(t)
  await openImport(root)
  const files = paths.map(([path, format]) => {
    const file = new File([clientDocuments[format]], path.split("/").at(-1))
    Object.defineProperty(file, "webkitRelativePath", { value: path })
    return file
  })
  files.push(new File(["not config"], "notes.txt"))
  await inputNamed(root, "Discover in selected directory").props.onChange({ target: { files, value: "" } }); await flush()
  assert.equal(importCalls(calls, "preview").length, 0)
  assert.equal(all(field(root, "Discovered configuration")).filter(element => element.type === "option").length, paths.length + 1)
  for (const [index, [path, format]] of paths.entries()) {
    const picker = field(root, "Discovered configuration")
    enter(picker, String(index))
    await picker.props.onChange(); await flush()
    await button(root, "Preview configuration").props.onClick(); await flush()
    const params = importCalls(calls, "preview").at(-1).params
    assert.equal("format" in params, false, path)
    assert.equal(JSON.parse(params.document).mcpServers.docs.command, `server-${format}`, path)
    await button(root, "Back").props.onClick(); await flush()
  }
  await chooseFile(root, clientDocuments.kimi, "server-settings.txt")
  enter(field(root, "Source format / client"), "kimi"); await flush()
  await button(root, "Preview configuration").props.onClick(); await flush()
  const params = importCalls(calls, "preview").at(-1).params
  assert.equal("format" in params, false)
  assert.equal(JSON.parse(params.document).mcpServers.docs.command, "server-kimi")
  assert.equal(importCalls(calls, "apply").length, 0)
})

test("the native preview and revision-only apply readers retain the upstream wire contract", () => {
  const native = importPreviewReply([
    importEntry({ status: "identical" }), importEntry({ id: "added", status: "changed" }),
    importEntry({ id: "taken", status: "conflict" }), importEntry({ id: "bad", status: "invalid", transport: undefined }),
  ])
  assert.deepEqual(readMcpImportPreview(native).entries.map(entry => entry.status), ["identical", "changed", "conflict", "invalid"])
  assert.equal(readMcpImportApplied({ revision: "source:next" }), "source:next")
  assert.throws(() => readMcpImportApplied({ imported: ["docs"], partial: [] }))
  assert.throws(() => readMcpImportPreview(importPreviewReply([importEntry({ status: "new" })])))
  assert.throws(() => readMcpImportPreview(importPreviewReply([importEntry({ status: "unchanged" })])))
})

test("dialog controls escape a disabled ancestor form and remain dismissible offline", async t => {
  const { root, connection } = await mountImport(t, { standalone: true, ancestorDisabled: true })
  await openImport(root)
  const dialog = dialogOf(root)
  assert.equal(dialog.parent, body)
  assert.equal(all(dialog).some(element => element.type === "form"), false)
  assert.ok(all(dialog).filter(element => element.type === "button").every(element => element.props.type === "button"))
  connection.phase = "reconnecting"; await flush()
  assert.equal(button(root, "Cancel").props.disabled, false)
  await button(root, "Cancel").props.onClick(); await flush()
  assert.equal(dialog.open, false)
})

test("unmount during file acquisition or awaited refresh discards late work", async t => {
  for (const stage of ["file", "refresh"]) {
    await t.test(stage, async t => {
      const pending = deferred()
      const { root, app, calls, busyEvents } = await mountImport(t, { standalone: true, refresh: () => pending.promise })
      await openImport(root)
      let request
      if (stage === "file") {
        const file = new File(["{}"], "config.json")
        Object.defineProperty(file, "text", { value: () => pending.promise })
        request = inputNamed(root, "Import configuration file").props.onChange({ target: { files: [file], value: "" } })
      } else {
        await chooseFile(root)
        await button(root, "Preview configuration").props.onClick(); await flush()
        await confirmSelection(root, ["docs"])
        request = button(root, "Confirm import 1").props.onClick()
      }
      await flush()
      assert.equal(busyEvents.at(-1), true)
      app.unmount()
      const eventsAtUnmount = busyEvents.length
      pending.resolve(stage === "file" ? "{}" : undefined)
      await request; await flush()
      assert.equal(busyEvents.at(-1), false)
      assert.equal(busyEvents.length, eventsAtUnmount)
      assert.equal(importCalls(calls, "preview").length, stage === "file" ? 0 : 1)
      assert.equal(all(root).some(element => element.type === "dialog"), false)
    })
  }
})

test("reselecting a folder replaces previous candidates rather than rereading old File handles", async t => {
  const { root, calls } = await mountImport(t)
  await openImport(root)
  for (const marker of ["before", "after"]) {
    const file = new File([JSON.stringify({ mcpServers: { [marker]: { command: `server-${marker}` } } })], "mcp.json")
    Object.defineProperty(file, "webkitRelativePath", { value: "root/.kimi/mcp.json" })
    await inputNamed(root, "Discover in selected directory").props.onChange({ target: { files: [file], value: "folder" } }); await flush()
    const picker = field(root, "Discovered configuration")
    enter(picker, "0")
    await picker.props.onChange(); await flush()
    await button(root, "Preview configuration").props.onClick(); await flush()
    assert.equal(JSON.parse(importCalls(calls, "preview").at(-1).params.document).mcpServers[marker].command, `server-${marker}`)
    assert.equal("format" in importCalls(calls, "preview").at(-1).params, false)
    await button(root, "Re-select folder").props.onClick(); await flush()
  }
  assert.notEqual(importCalls(calls, "preview")[0].params.document, importCalls(calls, "preview")[1].params.document)
})

test("an empty directory selection reports no candidates and keeps explicit-file import available", async t => {
  const { root, calls } = await mountImport(t)
  await openImport(root)
  await inputNamed(root, "Discover in selected directory").props.onChange({ target: { files: [new File(["notes"], "notes.txt")], value: "folder" } }); await flush()
  assert.match(text(root), /No recognized MCP configuration files/)
  assert.equal(button(root, "Preview configuration").props.disabled, true)
  assert.equal(importCalls(calls, "preview").length, 0)
  await chooseFile(root)
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.equal(importCalls(calls, "preview").length, 1)
})

test("a late parent catalog refresh cannot overwrite the catalog loaded after reconnect", async t => {
  const pending = deferred()
  const obsolete = { ...catalog(), servers: [{ id: "obsolete-server", source: "user", enabled: false, transport: "stdio" }] }
  const current = { ...catalog(), servers: [{ id: "current-server", source: "user", enabled: false, transport: "stdio" }] }
  const { root, connection, calls } = await mountImport(t, { catalogs: [catalog(), pending.promise, current] })
  await previewFile(root)
  await confirmSelection(root, ["docs"])
  const applied = button(root, "Confirm import 1").props.onClick(); await flush()
  connection.phase = "reconnecting"; await flush()
  assert.equal(button(root, "Done").props.disabled, false)
  await button(root, "Done").props.onClick(); await flush()
  connection.phase = "connected"; await flush()
  assert.match(text(root), /current-server/)
  pending.resolve(obsolete)
  await applied; await flush()
  assert.match(text(root), /current-server/)
  assert.doesNotMatch(text(root), /obsolete-server/)
  assert.equal(calls.filter(call => call.method === "mcp.catalog").length, 3)
})

test("failed apply requests require a new preview without claiming successful groups", async t => {
  for (const cause of [new RpcError(-32601, "Method not found", undefined), new Error("socket closed"), new RpcError(-32000, "rename target is taken", "mcp_import_conflict")]) {
    await t.test(cause.message, async t => {
      const { root, calls } = await mountImport(t, { apply: () => { throw cause } })
      await previewFile(root)
      await confirmSelection(root, ["docs"])
      await button(root, "Confirm import 1").props.onClick(); await flush()
      assert.doesNotMatch(text(root), /Import complete|Written target IDs|Imported \d/)
      assert.equal(button(root, "Next · review 1").props.disabled, true)
      assert.ok(button(root, "Refresh preview"))
      assert.equal(calls.filter(call => call.method === "mcp.catalog").length, 2)
    })
  }
})

test("all nine explicit client formats preview and apply only normalized native documents", async t => {
  for (const [format, document] of Object.entries(clientDocuments)) {
    await t.test(format, async t => {
      const { root, calls } = await mountImport(t)
      await openImport(root)
      await chooseFile(root, document, "custom-config.txt")
      enter(field(root, "Source format / client"), format); await flush()
      await button(root, "Preview configuration").props.onClick(); await flush()
      const preview = importCalls(calls, "preview")[0].params
      assert.deepEqual(Object.keys(preview).sort(), ["document", "source"])
      assert.equal(JSON.parse(preview.document).mcpServers.docs.command, `server-${format}`)
      if (format === "json") assert.equal(preview.document, document)
      else assert.deepEqual(Object.keys(JSON.parse(preview.document)), ["mcpServers"])
      await confirmSelection(root, ["docs"])
      await button(root, "Confirm import 1").props.onClick(); await flush()
      const applied = importCalls(calls, "apply")[0].params
      assert.deepEqual(applied, { source: "user", document: preview.document, expectedVersion: "user:1", resolutions: [{ id: "docs", action: "import" }] })
    })
  }
})

test("local adapter rejections remain visible but never enter the native document or resolutions", async t => {
  const secret = "adapter-secret-never-render"
  const document = JSON.stringify({ mcpServers: {
    docs: { command: "server" },
    rejected: { command: "server", timeout: 1234, env: { TOKEN: secret } },
  }, privateClientSetting: { token: secret } })
  const { root, calls } = await mountImport(t)
  await openImport(root)
  await chooseFile(root, document)
  enter(field(root, "Source format / client"), "omp"); await flush()
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.match(text(root), /Rejected by source adapter/)
  assert.match(text(root), /timeout/)
  assert.match(text(root), /0 \/ 2 selected/)
  assert.equal(text(root).includes(secret), false)
  assert.ok(all(root).some(element => element.props["data-tone"] === "warning" && text(element).length > 0), "ignored client settings have a visible safe warning")
  assert.equal(inputNamed(root, "Select rejected").props.disabled, true)
  assert.equal(actionNamed(root, "Actions for rejected"), undefined)
  const preview = importCalls(calls, "preview")[0].params
  assert.deepEqual(Object.keys(JSON.parse(preview.document).mcpServers), ["docs"])
  assert.equal(preview.document.includes(secret), false)
  assert.equal(preview.document.includes("privateClientSetting"), false)
  await confirmSelection(root, ["docs"])
  await button(root, "Confirm import 1").props.onClick(); await flush()
  const applied = importCalls(calls, "apply")[0].params
  assert.equal(applied.document, preview.document)
  assert.deepEqual(applied.resolutions, [{ id: "docs", action: "import" }])
})

test("an all-invalid adapted document is not presented as an empty source", async t => {
  const { root, calls } = await mountImport(t, { preview: importPreviewReply([]) })
  await openImport(root)
  await chooseFile(root, '{"mcpServers":{"rejected":{"command":"server","timeout":1234}}}')
  enter(field(root, "Source format / client"), "omp"); await flush()
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.match(text(root), /Rejected by source adapter/)
  assert.equal(inputNamed(root, "Select rejected").props.disabled, true)
  assert.doesNotMatch(text(root), /contains no MCP server entries/)
  assert.equal(button(root, "Next · review 0").props.disabled, true)
  assert.deepEqual(JSON.parse(importCalls(calls, "preview")[0].params.document), { mcpServers: {} })
  assert.equal(importCalls(calls, "apply").length, 0)
})

test("malformed foreign documents fail safely in the browser without any RPC", async t => {
  for (const [format, document] of [
    ["codex", '[mcp_servers.docs]\ncommand = "private-parser-excerpt'],
    ["kimi", '{"mcpServers":{"docs": "private-parser-excerpt"'],
    ["opencode", '// private-parser-excerpt\n{"mcp": {}}'],
  ]) {
    await t.test(format, async t => {
      const { root, calls } = await mountImport(t)
      await openImport(root)
      await chooseFile(root, document, "custom-config.txt")
      enter(field(root, "Source format / client"), format); await flush()
      await button(root, "Preview configuration").props.onClick(); await flush()
      const alert = all(root).find(element => element.props.role === "alert")
      assert.ok(alert)
      assert.ok(text(alert).length > 0)
      assert.equal(text(root).includes("private-parser-excerpt"), false)
      assert.doesNotMatch(text(root), /contains no MCP server entries/)
      assert.equal(importCalls(calls, "preview").length, 0)
      assert.equal(importCalls(calls, "apply").length, 0)
    })
  }
})

test("canceling a replacement picker preserves the already reviewed source snapshot", async t => {
  const document = '{"mcpServers":{"docs":{"command":"server"}}}'
  const { root, calls } = await mountImport(t)
  await previewFile(root, document)
  await button(root, "Re-select file").props.onClick(); await flush()
  const input = inputNamed(root, "Import configuration file"), dialog = dialogOf(root)
  dialog.props.onCancel({ target: input, currentTarget: dialog, preventDefault() { assert.fail("input cancel was intercepted") } })
  await input.props.onChange({ target: { files: [], value: "" } }); await flush()
  assert.equal(dialog.open, true)
  await confirmSelection(root, ["docs"])
  await button(root, "Confirm import 1").props.onClick(); await flush()
  assert.equal(importCalls(calls, "apply")[0].params.document, document)
  assert.equal(importCalls(calls, "preview").length, 1)
})

test("a new import session does not reuse the previous client's format", async t => {
  const { root, calls } = await mountImport(t)
  await openImport(root)
  await chooseFile(root, '{"mcp":{"docs":{"type":"local","command":["foreign-server"]}}}', "first-config.txt")
  enter(field(root, "Source format / client"), "opencode"); await flush()
  await button(root, "Preview configuration").props.onClick(); await flush()
  await button(root, "Cancel").props.onClick(); await flush()
  await openImport(root)
  const document = '{"mcpServers":{"docs":{"command":"native-server"}}}'
  await chooseFile(root, document, "second-config.txt")
  await button(root, "Preview configuration").props.onClick(); await flush()
  assert.equal(importCalls(calls, "preview").at(-1).params.document, document)
})
