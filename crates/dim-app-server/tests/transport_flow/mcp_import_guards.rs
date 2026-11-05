use super::*;
use dim_agent_capabilities::file_storage::{FileLease, FileStorage};
use dim_agent_runtime::{Modules, Names, wait_active};
use dim_app_server::{
    mcp::{
        McpAuth, McpChange, McpError, McpOwner, McpPlugin, McpPublication, McpService,
        config::{McpProjectEnablement, McpSecrets, McpSettings},
        server::{McpServerError, McpServerState},
    },
    settings::{SettingsChanged, SettingsPlugin, SettingsScope, SettingsService, settings_changes},
};
use rutis::host::{BoxFuture, DynPlugin, Effect, Key, TypeKey};
use rutis_loader::{Layer, LoaderPlugin, Patch};
use std::path::PathBuf;
use tokio::sync::{Notify, mpsc};

const DEADLINE: Duration = Duration::from_secs(10);

struct Changes {
    mcp: Key<McpService>,
    events: mpsc::UnboundedSender<SettingsChanged>,
}
impl DynPlugin for Changes {
    fn name(&self) -> &str {
        "McpImportChanges"
    }
    fn injects(&self) -> Vec<TypeKey> {
        vec![self.mcp.erase()]
    }
    fn apply<'a>(&'a self, ctx: &'a rutis::Ctx) -> BoxFuture<'a, rutis::Result<Effect>> {
        Box::pin(async move {
            for source in ["mcp", "mcp-projects", "mcp-secrets"] {
                let events = self.events.clone();
                ctx.listen::<SettingsChanged>()
                    .name(settings_changes(source))
                    .on(move |event, _| {
                        let _ = events.send((*event).clone());
                        async { Ok(None) }
                    })?;
            }
            Ok(Effect::Done)
        })
    }
}

struct Fixture {
    server: RunningServer,
    home: PathBuf,
    project: PathBuf,
    files: Arc<FileStorage>,
    settings: Arc<SettingsService>,
    mcp: Arc<McpService>,
    events: mpsc::UnboundedReceiver<SettingsChanged>,
}
impl Fixture {
    async fn new() -> Self {
        let home = std::env::temp_dir().join(format!("dm-import-guards-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join("project")).unwrap();
        let home = home.canonicalize().unwrap();
        let project = home.join("project");
        let (events, receiver) = mpsc::unbounded_channel();
        let (server, _) = launch_with(
            Arc::new(MockTools),
            ServerConfig {
                file_roots: vec![home.clone()],
                platform_home: Some(home.clone()),
                ..Default::default()
            },
            move |builder| {
                builder.plugin(|names| Ok(Box::new(SettingsPlugin::new(names, 0, vec![])?)));
                builder.plugin(|names| Ok(Box::new(McpPublication::new(names)?)));
                builder.plugin(|names| Ok(Box::new(McpPlugin::new(names, 0)?)));
                builder.plugin(move |names: &Names<'_>| {
                    Ok(Box::new(Changes {
                        mcp: names.key()?,
                        events: events.clone(),
                    }))
                });
            },
        )
        .await;
        let files = server.service::<FileStorage>().unwrap();
        let settings = server.service::<SettingsService>().unwrap();
        let mcp = server.service::<McpService>().unwrap();
        Self {
            server,
            home,
            project,
            files,
            settings,
            mcp,
            events: receiver,
        }
    }
    async fn client(&self) -> Client {
        Client::new_version(&self.server, false, 3).await
    }
    async fn catalog(&self, client: &mut Client) -> Value {
        let response = client.rpc("mcp.catalog", json!({"cwd":self.project})).await;
        assert_ok(&response);
        response["result"].clone()
    }
    async fn preview(&self, client: &mut Client, document: &str) -> Value {
        let response = client
            .rpc(
                "mcp.import.preview",
                json!({
                    "source":"project", "cwd":self.project, "document":document
                }),
            )
            .await;
        assert_ok(&response);
        response["result"].clone()
    }
    fn apply(&self, document: &str, revision: &Value, resolutions: Value) -> Value {
        json!({"source":"project", "cwd":self.project, "document":document,
            "expectedVersion":revision, "resolutions":resolutions})
    }
    async fn seed(&mut self, client: &mut Client, configuration: Value) {
        let document = document(configuration);
        let preview = self.preview(client, &document).await;
        assert_ok(
            &client
                .rpc(
                    "mcp.import.apply",
                    self.apply(
                        &document,
                        &preview["revision"],
                        json!([{"id":"guarded","action":"import"}]),
                    ),
                )
                .await,
        );
        tokio::time::timeout(DEADLINE, async {
            let (mut source, mut overlay) = (false, false);
            while !source || !overlay {
                match self.events.recv().await.unwrap().source.as_str() {
                    "mcp" => source = true,
                    "mcp-secrets" => overlay = true,
                    _ => {}
                }
            }
        })
        .await
        .expect("both seed writes were observed");
        let revision = self.catalog(client).await["projectRevision"].clone();
        assert_ok(&client.rpc("mcp.set_enabled", self.enable(&revision)).await);
        self.changed("mcp-projects").await;
        self.clear_events();
    }
    fn enable(&self, revision: &Value) -> Value {
        json!({"source":"project", "cwd":self.project, "id":"guarded",
            "expectedVersion":revision, "enabled":true})
    }
    fn clear_events(&mut self) {
        while self.events.try_recv().is_ok() {}
    }
    async fn changed(&mut self, source: &str) {
        tokio::time::timeout(DEADLINE, async {
            loop {
                if self
                    .events
                    .recv()
                    .await
                    .expect("settings event source closed")
                    .source
                    == source
                {
                    break;
                }
            }
        })
        .await
        .expect("the controlled mutation reached its storage boundary");
    }
    async fn hold(&self, path: &std::path::Path) -> FileLease {
        let path = self.files.resolve(path).unwrap();
        self.files
            .lock(&path, &CancellationToken::new())
            .await
            .unwrap()
    }
    fn stored(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.project.join(".mcp.json")).unwrap()).unwrap()
    }
    fn secrets(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.home.join("mcp-secrets.json")).unwrap()).unwrap()
    }
    async fn disabled(&self) {
        let record = self
            .settings
            .read::<McpProjectEnablement>(SettingsScope::User, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            !record
                .document
                .contains(self.project.to_str().unwrap(), "guarded")
        );
    }
    async fn close(self) {
        self.server.shutdown();
        tokio::time::timeout(DEADLINE, self.server.join())
            .await
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(self.home).unwrap();
    }
}
fn document(configuration: Value) -> String {
    json!({"mcpServers":{"guarded":configuration}}).to_string()
}
fn code(response: &Value) -> &str {
    response["error"]["data"]["appError"]
        .as_str()
        .unwrap_or_else(|| panic!("expected RPC failure: {response}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_unreadable_enablement_refuses_before_source_or_overlay_write() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(
            &mut client,
            json!({"command":"old-command","args":["old-argument"]}),
        )
        .await;
    let source_path = fixture.project.join(".mcp.json");
    let overlay_path = fixture.home.join("mcp-secrets.json");
    let enablement_path = fixture.home.join("mcp-projects.json");
    let source_before = std::fs::read(&source_path).unwrap();
    let overlay_before = std::fs::read(&overlay_path).unwrap();
    let enablement_before = std::fs::read(&enablement_path).unwrap();
    let document = document(json!({"command":"imported-command","args":["imported-argument"]}));
    let preview = fixture.preview(&mut client, &document).await;
    assert_eq!(
        fixture.catalog(&mut client).await["servers"][0]["enabled"],
        true
    );

    std::fs::remove_file(&enablement_path).unwrap();
    std::fs::create_dir(&enablement_path).unwrap();
    let rejected = client
        .rpc(
            "mcp.import.apply",
            fixture.apply(
                &document,
                &preview["revision"],
                json!([{"id":"guarded","action":"replace"}]),
            ),
        )
        .await;
    assert_eq!(code(&rejected), "mcp_settings_read");
    assert_eq!(std::fs::read(&source_path).unwrap(), source_before);
    assert_eq!(std::fs::read(&overlay_path).unwrap(), overlay_before);

    std::fs::remove_dir(&enablement_path).unwrap();
    std::fs::write(&enablement_path, &enablement_before).unwrap();
    let restored = fixture.catalog(&mut client).await;
    assert_eq!(restored["projectRevision"], preview["revision"]);
    assert_eq!(restored["servers"][0]["enabled"], true);
    let configuration = client
        .rpc(
            "mcp.configuration",
            json!({"source":"project","cwd":fixture.project,"id":"guarded"}),
        )
        .await;
    assert_ok(&configuration);
    assert_eq!(
        configuration["result"]["configuration"]["command"],
        "old-command"
    );
    assert_eq!(configuration["result"]["enabled"], true);
    assert_eq!(std::fs::read(&source_path).unwrap(), source_before);
    assert_eq!(std::fs::read(&overlay_path).unwrap(), overlay_before);
    assert_eq!(std::fs::read(&enablement_path).unwrap(), enablement_before);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_source_cas_after_withdrawal_preserves_external_edit_and_stays_disabled() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(
            &mut client,
            json!({"command":"old-command","args":["old-argument"]}),
        )
        .await;
    let source_path = fixture.project.join(".mcp.json");
    let overlay_path = fixture.home.join("mcp-secrets.json");
    let source_before = std::fs::read(&source_path).unwrap();
    let overlay_before = std::fs::read(&overlay_path).unwrap();
    let document = document(json!({"command":"imported-command","args":["imported-argument"]}));
    let preview = fixture.preview(&mut client, &document).await;
    let mut lease = fixture.hold(&source_path).await;
    let request = client
        .send(
            "mcp.import.apply",
            fixture.apply(
                &document,
                &preview["revision"],
                json!([{"id":"guarded","action":"replace"}]),
            ),
        )
        .await;
    fixture.changed("mcp-projects").await;
    fixture.disabled().await;
    assert_eq!(std::fs::read(&source_path).unwrap(), source_before);
    assert_eq!(std::fs::read(&overlay_path).unwrap(), overlay_before);

    let mut external = fixture.stored();
    external["mcpServers"]["guarded"]["command"] = json!("external-command");
    lease
        .replace(
            serde_json::to_vec_pretty(&external).unwrap(),
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    drop(lease);
    assert_eq!(
        code(&client.response(request).await),
        "mcp_settings_conflict"
    );
    assert_eq!(fixture.stored(), external);
    assert_eq!(std::fs::read(&overlay_path).unwrap(), overlay_before);
    fixture.disabled().await;
    let current = fixture.catalog(&mut client).await;
    assert_ne!(current["projectRevision"], preview["revision"]);
    assert_eq!(current["servers"][0]["enabled"], false);
    let configuration = client
        .rpc(
            "mcp.configuration",
            json!({"source":"project","cwd":fixture.project,"id":"guarded"}),
        )
        .await;
    assert_ok(&configuration);
    assert_eq!(
        configuration["result"]["configuration"]["command"],
        "external-command"
    );
    assert_eq!(configuration["result"]["enabled"], false);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_serializes_old_enables_and_survives_caller_disconnect() {
    for replacement in [
        json!({"command":"new-command","args":["new-argument"]}),
        json!({"command":"old-command","args":["new-argument"]}),
    ] {
        let mut fixture = Fixture::new().await;
        let mut reader = fixture.client().await;
        fixture
            .seed(
                &mut reader,
                json!({"command":"old-command","args":["old-argument"]}),
            )
            .await;
        let old_file = std::fs::read(fixture.project.join(".mcp.json")).unwrap();
        let document = document(replacement.clone());
        let preview = fixture.preview(&mut reader, &document).await;
        let revision = preview["revision"].clone();
        let lease = fixture.hold(&fixture.project.join(".mcp.json")).await;
        let mut importer = fixture.client().await;
        importer
            .send(
                "mcp.import.apply",
                fixture.apply(
                    &document,
                    &revision,
                    json!([{"id":"guarded","action":"replace"}]),
                ),
            )
            .await;
        fixture.changed("mcp-projects").await;
        fixture.disabled().await;
        assert_eq!(
            std::fs::read(fixture.project.join(".mcp.json")).unwrap(),
            old_file
        );
        let mut enabling = fixture.client().await;
        let enable = enabling
            .send("mcp.set_enabled", fixture.enable(&revision))
            .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(200), enabling.response(enable))
                .await
                .is_err(),
            "enable must wait for the owner of the replacement"
        );
        let readable = fixture.catalog(&mut reader).await;
        assert_eq!(readable["servers"][0]["enabled"], false);
        assert_eq!(readable["projectRevision"], revision);
        drop(importer);
        drop(lease);
        let response = enabling.response(enable).await;
        assert_eq!(code(&response), "mcp_settings_conflict");
        let current = fixture.catalog(&mut reader).await;
        assert_ne!(current["projectRevision"], revision);
        assert_eq!(current["servers"][0]["enabled"], false);
        assert_eq!(
            fixture.secrets()["entries"][fixture.project.to_str().unwrap()]["guarded"]["args"],
            json!(["new-argument"])
        );
        if replacement["command"] == "old-command" {
            assert_eq!(
                std::fs::read(fixture.project.join(".mcp.json")).unwrap(),
                old_file,
                "overlay-only replacements must invalidate old enable tokens too"
            );
        }
        let delayed = reader
            .rpc("mcp.set_enabled", fixture.enable(&revision))
            .await;
        assert_eq!(code(&delayed), "mcp_settings_conflict");
        let editable = reader
            .rpc(
                "mcp.configuration",
                json!({"source":"project","cwd":fixture.project,"id":"guarded"}),
            )
            .await;
        assert_ok(&editable);
        assert_eq!(editable["result"]["revision"], current["projectRevision"]);
        assert_ok(
            &reader
                .rpc(
                    "mcp.set_enabled",
                    fixture.enable(&current["projectRevision"]),
                )
                .await,
        );
        fixture.close().await;
    }
}

#[derive(Default)]
struct Remote {
    initialized: AtomicUsize,
    deleting: Notify,
    release_delete: CancellationToken,
}
impl Remote {
    async fn start() -> (Arc<Self>, String, tokio::task::JoinHandle<()>) {
        let remote = Arc::new(Self::default());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let router = axum::Router::new()
            .route(
                "/mcp",
                axum::routing::post(remote_rpc).delete(remote_delete),
            )
            .with_state(remote.clone());
        let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (remote, url, http)
    }
}
async fn remote_rpc(
    axum::extract::State(remote): axum::extract::State<Arc<Remote>>,
    axum::Json(message): axum::Json<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let result = match message["method"].as_str().unwrap() {
        "initialize" => {
            remote.initialized.fetch_add(1, Ordering::SeqCst);
            json!({"protocolVersion":message["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"import-guard","version":"1"}})
        }
        "tools/list" => json!({"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}),
        _ => return axum::http::StatusCode::ACCEPTED.into_response(),
    };
    (
        [("mcp-session-id", "guard-session")],
        axum::Json(json!({"jsonrpc":"2.0","id":message["id"],"result":result})),
    )
        .into_response()
}
async fn remote_delete(
    axum::extract::State(remote): axum::extract::State<Arc<Remote>>,
) -> axum::http::StatusCode {
    remote.deleting.notify_one();
    remote.release_delete.cancelled().await;
    axum::http::StatusCode::NO_CONTENT
}
async fn connection_owner(fixture: &Fixture) -> (rutis::Ctx, McpOwner) {
    let root = rutis::Ctx::root().unwrap();
    root.provide_as::<McpAuth>(fixture.server.service::<McpAuth>().unwrap())
        .unwrap();
    let mut builtins = Modules::new();
    let template = McpPublication::standalone_template(&mut builtins);
    let plugin = LoaderPlugin::new(builtins, Default::default());
    let loader = plugin.handle();
    let view = root.plugin(plugin);
    wait_active(&root, &[view], DEADLINE, &CancellationToken::new())
        .await
        .unwrap();
    let report = loader
        .reconcile(
            vec![Layer::new(
                "assembly",
                vec![Patch {
                    insert: Some(vec![template]),
                    ..Default::default()
                }],
            )],
            None,
        )
        .await
        .unwrap();
    assert!(report.failures.is_empty() && report.issues.is_empty());
    let owner = McpOwner::new(root.clone(), loader);
    (root, owner)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_retires_retained_transport_before_partial_overlay_failure() {
    let (remote, url, http) = Remote::start().await;
    let (blocker, blocker_url, blocker_http) = Remote::start().await;
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(
            &mut client,
            json!({"type":"http","url":url,"auth":{"type":"bearer","token":"fixture-only"}}),
        )
        .await;
    let (root, owner) = connection_owner(&fixture).await;
    let project = fixture.settings.project_root(&fixture.project).unwrap();
    let retained = fixture
        .mcp
        .server(
            owner.clone(),
            Some(project),
            "guarded".into(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        retained
            .tools(&CancellationToken::new())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(retained.state(), McpServerState::Connected);
    let user_revision = fixture.catalog(&mut client).await["userRevision"].clone();
    assert_ok(&client.rpc("mcp.save", json!({"source":"user","id":"blocker","expectedVersion":user_revision,"configuration":{"type":"http","url":blocker_url}})).await);
    fixture.changed("mcp").await;
    let blocking = fixture
        .mcp
        .server(owner, None, "blocker".into(), &CancellationToken::new())
        .await
        .unwrap();
    blocking.tools(&CancellationToken::new()).await.unwrap();
    let mut disconnecting = fixture.client().await;
    let disconnect = disconnecting
        .send("mcp.disconnect", json!({"source":"user","id":"blocker"}))
        .await;
    tokio::time::timeout(DEADLINE, blocker.deleting.notified())
        .await
        .unwrap();
    let before = fixture.stored();
    let old_overlay = std::fs::read(fixture.home.join("mcp-secrets.json")).unwrap();
    let overlay = fixture.hold(&fixture.home.join("mcp-secrets.json")).await;
    let document = document(json!({"command":"never-executed"}));
    let preview = fixture.preview(&mut client, &document).await;
    let request = client
        .send(
            "mcp.import.apply",
            fixture.apply(
                &document,
                &preview["revision"],
                json!([{"id":"guarded","action":"replace"}]),
            ),
        )
        .await;
    fixture.changed("mcp-projects").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), fixture.changed("mcp"))
            .await
            .is_err(),
        "an import must wait for publication retirement before committing a replacement skeleton"
    );
    assert_eq!(fixture.stored(), before);
    assert_eq!(retained.state(), McpServerState::Connected);
    blocker.release_delete.cancel();
    assert_ok(&disconnecting.response(disconnect).await);
    tokio::time::timeout(DEADLINE, remote.deleting.notified())
        .await
        .expect("the old HTTP generation must retire before its skeleton changes");
    assert_eq!(fixture.stored(), before);
    assert!(retained.withdrawn());
    remote.release_delete.cancel();
    let mut state = retained.subscribe();
    tokio::time::timeout(
        DEADLINE,
        state.wait_for(|state| *state == McpServerState::Closed),
    )
    .await
    .unwrap()
    .unwrap();
    fixture.changed("mcp").await;
    assert_eq!(
        fixture.stored()["mcpServers"]["guarded"],
        json!({"command":"never-executed"})
    );
    let secrets_path = fixture.home.join("mcp-secrets.json");
    std::fs::remove_file(&secrets_path).unwrap();
    std::fs::create_dir(&secrets_path).unwrap();
    drop(overlay);
    let response = client.response(request).await;
    assert_eq!(code(&response), "mcp_import_partial");
    fixture.disabled().await;
    assert_eq!(retained.state(), McpServerState::Closed);
    assert!(matches!(
        retained.tools(&CancellationToken::new()).await,
        Err(McpServerError::Closed)
    ));
    assert_eq!(remote.initialized.load(Ordering::SeqCst), 1);
    std::fs::remove_dir(&secrets_path).unwrap();
    std::fs::write(&secrets_path, old_overlay).unwrap();
    let preview = fixture.preview(&mut client, &document).await;
    assert_eq!(preview["entries"][0]["status"], "conflict");
    assert_ok(
        &client
            .rpc(
                "mcp.import.apply",
                fixture.apply(
                    &document,
                    &preview["revision"],
                    json!([{"id":"guarded","action":"replace"}]),
                ),
            )
            .await,
    );
    let configuration = client
        .rpc(
            "mcp.configuration",
            json!({"source":"project","cwd":fixture.project,"id":"guarded"}),
        )
        .await;
    assert_ok(&configuration);
    assert_eq!(configuration["result"]["enabled"], false);
    assert_eq!(configuration["result"]["secretsInUserScope"], false);
    drop((retained, blocking));
    root.shutdown().await.unwrap();
    fixture.close().await;
    http.abort();
    blocker_http.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_overlay_cas_preserves_newer_same_id_and_commutes_other_ids() {
    for (id, argument) in [
        ("guarded", "newer-argument"),
        ("guarded", "old-argument"),
        ("unrelated", "newer-argument"),
    ] {
        let mut fixture = Fixture::new().await;
        let mut client = fixture.client().await;
        fixture
            .seed(
                &mut client,
                json!({"command":"old-command","args":["old-argument"]}),
            )
            .await;
        let document = document(json!({"command":"replacement","args":["imported-argument"]}));
        let preview = fixture.preview(&mut client, &document).await;
        let mut overlay = fixture.hold(&fixture.home.join("mcp-secrets.json")).await;
        let request = client
            .send(
                "mcp.import.apply",
                fixture.apply(
                    &document,
                    &preview["revision"],
                    json!([{"id":"guarded","action":"replace"}]),
                ),
            )
            .await;
        fixture.changed("mcp").await;
        let mut newer = fixture.secrets();
        newer["entries"][fixture.project.to_str().unwrap()][id] =
            json!({"$generation":"newer-fixture-generation","args":[argument]});
        overlay
            .replace(
                serde_json::to_vec_pretty(&newer).unwrap(),
                None,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        drop(overlay);
        let response = client.response(request).await;
        if id == "guarded" {
            assert_eq!(code(&response), "mcp_import_partial");
        } else {
            assert_ok(&response);
            assert_eq!(
                fixture.secrets()["entries"][fixture.project.to_str().unwrap()]["guarded"]["args"],
                json!(["imported-argument"])
            );
        }
        assert_eq!(
            fixture.secrets()["entries"][fixture.project.to_str().unwrap()][id],
            newer["entries"][fixture.project.to_str().unwrap()][id]
        );
        fixture.disabled().await;
        fixture.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_orphan_overlay_reserves_rename_destination() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(
            &mut client,
            json!({"command":"old-command","args":["orphan-argument"]}),
        )
        .await;
    std::fs::write(fixture.project.join(".mcp.json"), b"{\"mcpServers\":{}}\n").unwrap();
    let source_before = std::fs::read(fixture.project.join(".mcp.json")).unwrap();
    let overlay_before = std::fs::read(fixture.home.join("mcp-secrets.json")).unwrap();
    let document = json!({"mcpServers":{"incoming":{"command":"replacement"}}}).to_string();
    let preview = fixture.preview(&mut client, &document).await;
    let rejected = client
        .rpc(
            "mcp.import.apply",
            fixture.apply(
                &document,
                &preview["revision"],
                json!([{"id":"incoming","action":"rename","newId":"guarded"}]),
            ),
        )
        .await;
    assert_eq!(code(&rejected), "mcp_import_conflict");
    assert_eq!(
        std::fs::read(fixture.project.join(".mcp.json")).unwrap(),
        source_before
    );
    assert_eq!(
        std::fs::read(fixture.home.join("mcp-secrets.json")).unwrap(),
        overlay_before
    );
    assert_ok(
        &client
            .rpc(
                "mcp.import.apply",
                fixture.apply(
                    &document,
                    &preview["revision"],
                    json!([{"id":"incoming","action":"rename","newId":"free"}]),
                ),
            )
            .await,
    );
    assert_eq!(
        fixture.stored()["mcpServers"]["free"],
        json!({"command":"replacement"})
    );
    assert_eq!(
        fixture.secrets()["entries"][fixture.project.to_str().unwrap()]["guarded"]["args"],
        json!(["orphan-argument"])
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_cancelled_waiters_and_owner_close_do_not_deadlock() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(
            &mut client,
            json!({"command":"old-command","args":["old-argument"]}),
        )
        .await;
    let document = document(json!({"command":"replacement","args":["new-argument"]}));
    let preview = fixture.preview(&mut client, &document).await;
    let overlay = fixture.hold(&fixture.home.join("mcp-secrets.json")).await;
    let request = client
        .send(
            "mcp.import.apply",
            fixture.apply(
                &document,
                &preview["revision"],
                json!([{"id":"guarded","action":"replace"}]),
            ),
        )
        .await;
    fixture.changed("mcp").await;
    let project = fixture.settings.project_root(&fixture.project).unwrap();
    let cancel = CancellationToken::new();
    let mcp = fixture.mcp.clone();
    let update = mcp.update(
        SettingsScope::Project(project),
        preview["revision"].as_str().unwrap().to_owned(),
        "guarded".into(),
        McpChange::SetEnabled(true),
        &cancel,
    );
    tokio::pin!(update);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut update)
            .await
            .is_err()
    );
    cancel.cancel();
    assert!(matches!(
        tokio::time::timeout(DEADLINE, update).await.unwrap(),
        Err(McpError::Cancelled)
    ));
    let restart = fixture.server.restart("Mcp");
    let response = client.response(request);
    let (restarted, response) =
        tokio::time::timeout(DEADLINE, async { tokio::join!(restart, response) })
            .await
            .expect("owner close cancels the queued mutation and blocked overlay write");
    restarted.unwrap();
    assert_eq!(code(&response), "mcp_import_partial");
    drop(overlay);
    fixture.disabled().await;
    assert_eq!(
        fixture.stored()["mcpServers"]["guarded"]["command"],
        "replacement"
    );
    let catalog = fixture.catalog(&mut client).await;
    assert_eq!(catalog["servers"][0]["enabled"], false);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_project_management_tokens_cover_overlay_edits_for_every_mutation() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(
            &mut client,
            json!({"command":"unchanged","args":["old-argument"]}),
        )
        .await;
    let document = document(json!({"command":"unchanged","args":["new-argument"]}));
    let preview = fixture.preview(&mut client, &document).await;
    let old = preview["revision"].clone();
    let root = fixture.settings.project_root(&fixture.project).unwrap();
    let raw = fixture
        .settings
        .read::<McpSettings>(SettingsScope::Project(root), &CancellationToken::new())
        .await
        .unwrap();
    let secrets = fixture
        .settings
        .read::<McpSecrets>(SettingsScope::User, &CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(old, raw.revision);
    assert!(
        !preview.to_string().contains(&secrets.revision),
        "secret-file digests are not public tokens"
    );
    let replaced = client
        .rpc(
            "mcp.import.apply",
            fixture.apply(
                &document,
                &old,
                json!([{"id":"guarded","action":"replace"}]),
            ),
        )
        .await;
    assert_ok(&replaced);
    let current = fixture.catalog(&mut client).await;
    assert_eq!(replaced["result"]["revision"], current["projectRevision"]);
    assert_ne!(old, current["projectRevision"]);
    let latest = fixture
        .settings
        .read::<McpSettings>(SettingsScope::Project(root), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(raw.revision, latest.revision, "only the overlay changed");
    for (method, params) in [
        ("mcp.set_enabled", fixture.enable(&old)),
        ("mcp.set_enabled", fixture.enable(&json!(raw.revision))),
        (
            "mcp.update",
            json!({"source":"project","cwd":fixture.project,"id":"guarded","expectedVersion":old,"patch":{"command":"stale"}}),
        ),
        (
            "mcp.remove",
            json!({"source":"project","cwd":fixture.project,"id":"guarded","expectedVersion":old}),
        ),
        (
            "mcp.move",
            json!({"from":"project","to":"user","cwd":fixture.project,"id":"guarded","expectedFromVersion":old,"expectedToVersion":current["userRevision"]}),
        ),
        (
            "mcp.import.apply",
            fixture.apply(
                &document,
                &old,
                json!([{"id":"guarded","action":"replace"}]),
            ),
        ),
    ] {
        let rejected = client.rpc(method, params).await;
        assert_eq!(
            code(&rejected),
            "mcp_settings_conflict",
            "{method}: {rejected}"
        );
    }
    assert_ok(&client.rpc("mcp.save", json!({"source":"user","id":"incoming","expectedVersion":current["userRevision"],"configuration":{"command":"incoming","enabled":false}})).await);
    let source = fixture.catalog(&mut client).await;
    let into_project = json!({"from":"user","to":"project","cwd":fixture.project,"id":"incoming","expectedFromVersion":source["userRevision"],"expectedToVersion":old});
    assert_eq!(
        code(&client.rpc("mcp.move", into_project).await),
        "mcp_settings_conflict"
    );
    assert_ok(&client.rpc("mcp.move", json!({"from":"user","to":"project","cwd":fixture.project,"id":"incoming","expectedFromVersion":source["userRevision"],"expectedToVersion":source["projectRevision"]})).await);
    fixture.disabled().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_current_tokens_stay_stable_while_publication_retires_an_older_snapshot() {
    let (remote, url, http) = Remote::start().await;
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(&mut client, json!({"type":"http","url":url}))
        .await;
    let (root, owner) = connection_owner(&fixture).await;
    let project = fixture.settings.project_root(&fixture.project).unwrap();
    let retained = fixture
        .mcp
        .server(
            owner,
            Some(project),
            "guarded".into(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    retained.tools(&CancellationToken::new()).await.unwrap();
    let old = fixture.catalog(&mut client).await["projectRevision"].clone();
    let disabling = client.send("mcp.set_enabled", json!({"source":"project","cwd":fixture.project,"id":"guarded","expectedVersion":old,"enabled":false})).await;
    tokio::time::timeout(DEADLINE, remote.deleting.notified())
        .await
        .unwrap();
    let mut changed = fixture.stored();
    changed["fixtureRevision"] = json!("newer-source-snapshot");
    let mut file = fixture.hold(&fixture.project.join(".mcp.json")).await;
    file.replace(
        serde_json::to_vec_pretty(&changed).unwrap(),
        None,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    drop(file);
    let mut reader = fixture.client().await;
    let current = fixture.catalog(&mut reader).await["projectRevision"].clone();
    assert_ne!(old, current);
    for _ in 0..3 {
        let catalog = fixture.catalog(&mut reader).await;
        assert_eq!(catalog["projectRevision"], current);
        assert_ne!(catalog["projectApplication"]["appliedRevision"], current);
        let configuration = reader
            .rpc(
                "mcp.configuration",
                json!({"source":"project","cwd":fixture.project,"id":"guarded"}),
            )
            .await;
        assert_ok(&configuration);
        assert_eq!(configuration["result"]["revision"], current);
    }
    remote.release_delete.cancel();
    assert_ok(&client.response(disabling).await);
    assert_ok(
        &reader
            .rpc(
                "mcp.inspect",
                json!({"source":"project","cwd":fixture.project,"id":"guarded"}),
            )
            .await,
    );
    let settled = fixture.catalog(&mut reader).await;
    assert_eq!(settled["projectRevision"], current);
    assert_eq!(settled["projectApplication"]["appliedRevision"], current);
    assert_eq!(retained.state(), McpServerState::Closed);
    drop(retained);
    root.shutdown().await.unwrap();
    fixture.close().await;
    http.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_stale_disable_retires_retained_generation_with_unreadable_overlay() {
    let (remote, url, http) = Remote::start().await;
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(&mut client, json!({"type":"http","url":url}))
        .await;
    let (root, owner) = connection_owner(&fixture).await;
    let project = fixture.settings.project_root(&fixture.project).unwrap();
    let retained = fixture
        .mcp
        .server(
            owner,
            Some(project),
            "guarded".into(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    retained.tools(&CancellationToken::new()).await.unwrap();
    let secrets_path = fixture.home.join("mcp-secrets.json");
    let original = std::fs::read(&secrets_path).unwrap();
    std::fs::remove_file(&secrets_path).unwrap();
    std::fs::create_dir(&secrets_path).unwrap();
    let request = client.send("mcp.set_enabled", json!({"source":"project","cwd":fixture.project,"id":"guarded","expectedVersion":"stale","enabled":false})).await;
    tokio::time::timeout(DEADLINE, remote.deleting.notified())
        .await
        .expect("revocation must not depend on a readable overlay");
    fixture.disabled().await;
    assert!(retained.withdrawn());
    remote.release_delete.cancel();
    assert_ok(&client.response(request).await);
    assert_eq!(retained.state(), McpServerState::Closed);
    std::fs::remove_dir(&secrets_path).unwrap();
    std::fs::write(&secrets_path, original).unwrap();
    drop(retained);
    root.shutdown().await.unwrap();
    fixture.close().await;
    http.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_import_orders_update_move_and_overlay_cleanup_on_one_gate() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.client().await;
    fixture
        .seed(
            &mut client,
            json!({"command":"old-command","args":["old-argument"]}),
        )
        .await;
    let catalog = fixture.catalog(&mut client).await;
    assert_ok(&client.rpc("mcp.save", json!({"source":"user","id":"incoming","expectedVersion":catalog["userRevision"],"configuration":{"command":"incoming","enabled":false}})).await);
    let catalog = fixture.catalog(&mut client).await;
    fixture.clear_events();
    let document = document(json!({"command":"replacement","args":["new-argument"]}));
    let file = fixture.hold(&fixture.project.join(".mcp.json")).await;
    let request = client
        .send(
            "mcp.import.apply",
            fixture.apply(
                &document,
                &catalog["projectRevision"],
                json!([{"id":"guarded","action":"replace"}]),
            ),
        )
        .await;
    fixture.changed("mcp-projects").await;
    let project = fixture.settings.project_root(&fixture.project).unwrap();
    let old_overlay = fixture
        .mcp
        .overlay(
            SettingsScope::Project(project),
            "guarded".into(),
            &CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
    let mut updater = fixture.client().await;
    let update = updater.send("mcp.update", json!({"source":"user","id":"incoming","expectedVersion":catalog["userRevision"],"patch":{"command":"updated"}})).await;
    let mut mover = fixture.client().await;
    let moving = mover.send("mcp.move", json!({"from":"user","to":"project","cwd":fixture.project,"id":"incoming","expectedFromVersion":catalog["userRevision"],"expectedToVersion":catalog["projectRevision"]})).await;
    let mcp = fixture.mcp.clone();
    let cancel = CancellationToken::new();
    let cleanup = mcp.clear_secret_if(
        SettingsScope::Project(project),
        "guarded".into(),
        old_overlay.generation,
        &cancel,
    );
    tokio::pin!(cleanup);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut cleanup)
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(200), updater.response(update))
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(200), mover.response(moving))
            .await
            .is_err()
    );
    let readable = fixture.catalog(&mut fixture.client().await).await;
    assert_eq!(readable["userRevision"], catalog["userRevision"]);
    drop(file);
    assert_ok(&client.response(request).await);
    assert_ok(&updater.response(update).await);
    assert_eq!(code(&mover.response(moving).await), "mcp_settings_conflict");
    tokio::time::timeout(DEADLINE, cleanup)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        fixture.secrets()["entries"][fixture.project.to_str().unwrap()]["guarded"]["args"],
        json!(["new-argument"])
    );
    fixture.disabled().await;
    fixture.close().await;
}
