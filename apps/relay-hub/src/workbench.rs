use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use relay_hermes_session::{GatewayEndpoint, HermesSessionAdapter};
use relay_session::jsonl::redact_and_bound_display;
use relay_session::{
    ChatCategory, ChatRole, ChatSignal, DEFAULT_DEADLINE, ProcessTransport, RichChatEvent,
    SessionError, Supervisor,
};
use serde_json::{Value, json};

const MAX_CWD_LENGTH: usize = 512;
const MAX_NAME_LENGTH: usize = 96;
const MAX_MESSAGE_LENGTH: usize = 8_192;
const MAX_STORED_EVENTS: usize = 128;
const MAX_STORED_SESSIONS: usize = 32;
const MAX_STORED_SESSION_ID_LENGTH: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkbenchError {
    code: &'static str,
}

impl WorkbenchError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub const fn code(self) -> &'static str {
        self.code
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Hermes,
    Codex,
}

impl Provider {
    fn parse(value: &str) -> Result<Self, WorkbenchError> {
        match value {
            "hermes" => Ok(Self::Hermes),
            "codex" => Ok(Self::Codex),
            _ => Err(WorkbenchError::new("unsupported_provider")),
        }
    }

    const fn code(self) -> &'static str {
        match self {
            Self::Hermes => "hermes",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone)]
struct Workspace {
    id: String,
    name: String,
    cwd: PathBuf,
}

struct StoredSession {
    id: String,
    workspace_id: String,
    provider: Provider,
    provider_session_id: String,
    status: String,
    events: VecDeque<RichChatEvent>,
    next_event_sequence: u64,
    reported_dropped: u64,
    live: LiveSession,
}

enum LiveSession {
    Hermes {
        adapter: HermesSessionAdapter,
        live_id: String,
    },
    Codex {
        supervisor: Supervisor<ProcessTransport>,
        active_turn: Option<String>,
    },
}

/// Hub-owned one-node Workbench state. It deliberately stores only the approved
/// CWD binding, opaque provider IDs, bounded neutral provider events, and user
/// submitted text required to reopen a recent conversation after a browser
/// refresh. Provider credentials and raw protocol frames never enter this type.
pub struct Workbench {
    approved_roots: Vec<PathBuf>,
    hermes_endpoint: Option<GatewayEndpoint>,
    owner_session: Option<String>,
    workspaces: Vec<Workspace>,
    selected_workspace_id: Option<String>,
    sessions: HashMap<String, StoredSession>,
    next_workspace_id: u64,
    next_session_id: u64,
}

impl Workbench {
    pub fn new(
        approved_roots: Vec<PathBuf>,
        hermes_endpoint: Option<GatewayEndpoint>,
    ) -> Result<Self, WorkbenchError> {
        let approved_roots = approved_roots
            .into_iter()
            .map(|root| canonical_directory(&root))
            .collect::<Result<Vec<_>, _>>()?;
        if approved_roots.is_empty() {
            return Err(WorkbenchError::new("workspace_root_required"));
        }
        Ok(Self {
            approved_roots,
            hermes_endpoint,
            owner_session: None,
            workspaces: Vec::new(),
            selected_workspace_id: None,
            sessions: HashMap::new(),
            next_workspace_id: 1,
            next_session_id: 1,
        })
    }

    /// Bind this in-memory workbench to the first authenticated browser session.
    /// The opaque session value remains local-only and is never serialized.
    pub fn authorize(&mut self, session: &str) -> Result<(), WorkbenchError> {
        match self.owner_session.as_deref() {
            Some(owner) if owner == session => Ok(()),
            Some(_) => Err(WorkbenchError::new("workbench_owner_mismatch")),
            None => {
                self.owner_session = Some(session.to_owned());
                Ok(())
            }
        }
    }

    pub fn snapshot(&mut self) -> Value {
        let workspaces = self
            .workspaces
            .iter()
            .map(workspace_json)
            .collect::<Vec<_>>();
        let sessions = self.sessions_snapshot();
        json!({
            "workspaces": workspaces,
            "selectedWorkspaceId": self.selected_workspace_id,
            "sessions": sessions,
            "providers": {
                "hermes": self.hermes_endpoint.is_some(),
                "codex": true,
            },
        })
    }

    pub fn add_workspace(&mut self, body: &Value) -> Result<Value, WorkbenchError> {
        let cwd = body_string(body, "cwd", MAX_CWD_LENGTH)?;
        let cwd = self.approved_cwd(&cwd)?;
        let name = body
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= MAX_NAME_LENGTH)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                cwd.file_name()
                    .and_then(|value| value.to_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Workspace")
                    .to_owned()
            });

        if let Some(existing) = self
            .workspaces
            .iter()
            .find(|workspace| workspace.cwd == cwd)
        {
            return Ok(workspace_json(existing));
        }

        let workspace = Workspace {
            id: format!("workspace-{}", self.next_workspace_id),
            name,
            cwd,
        };
        self.next_workspace_id += 1;
        let response = workspace_json(&workspace);
        self.workspaces.push(workspace);
        Ok(response)
    }

    pub fn select_workspace(&mut self, body: &Value) -> Result<Value, WorkbenchError> {
        let workspace_id = body_string(body, "workspaceId", MAX_STORED_SESSION_ID_LENGTH)?;
        let workspace = self
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or(WorkbenchError::new("unknown_workspace"))?;
        self.selected_workspace_id = Some(workspace.id.clone());
        Ok(workspace_json(workspace))
    }

    pub fn sessions_snapshot(&mut self) -> Value {
        self.pump_all();
        let mut sessions = self.sessions.values().collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.id.cmp(&right.id));
        Value::Array(sessions.into_iter().map(session_json).collect())
    }

    pub fn start_session(&mut self, body: &Value) -> Result<Value, WorkbenchError> {
        let workspace = self.workspace_from_body(body)?.clone();
        let provider = Provider::parse(&body_string(body, "provider", 16)?)?;
        let session = self.create_provider_session(provider, &workspace, None)?;
        let response = session_json(&session);
        self.sessions.insert(session.id.clone(), session);
        Ok(response)
    }

    pub fn resume_session(&mut self, body: &Value) -> Result<Value, WorkbenchError> {
        let workspace = self.workspace_from_body(body)?.clone();
        let provider = Provider::parse(&body_string(body, "provider", 16)?)?;
        let stored_id = body_string(body, "providerSessionId", MAX_STORED_SESSION_ID_LENGTH)?;
        if provider == Provider::Hermes
            && !self.has_provider_session(&workspace.id, provider, &stored_id)
        {
            return Err(WorkbenchError::new("unknown_provider_session"));
        }
        let session = self.create_provider_session(provider, &workspace, Some(&stored_id))?;
        let response = session_json(&session);
        self.sessions.insert(session.id.clone(), session);
        Ok(response)
    }

    pub fn send_message(&mut self, body: &Value) -> Result<Value, WorkbenchError> {
        let session_id = body_string(body, "sessionId", MAX_STORED_SESSION_ID_LENGTH)?;
        let text = body_string(body, "text", MAX_MESSAGE_LENGTH)?;
        let session = self
            .sessions
            .get_mut(&session_id)
            .ok_or(WorkbenchError::new("unknown_session"))?;
        let echo = redact_and_bound_display(&text);
        push_session_event(
            session,
            ChatRole::User,
            ChatCategory::Message,
            "message.sent",
            echo,
            None,
        );

        let result = match &mut session.live {
            LiveSession::Hermes { adapter, live_id } => adapter
                .prompt(live_id, &text)
                .map_err(|error| WorkbenchError::new(error.code())),
            LiveSession::Codex {
                supervisor,
                active_turn,
            } => supervisor
                .prompt(&text, DEFAULT_DEADLINE)
                .map(|turn_id| {
                    *active_turn = Some(turn_id);
                })
                .map_err(map_codex_error),
        };

        if let Err(error) = result {
            session.status = "error".to_owned();
            push_error(session, error.code());
            return Err(error);
        }
        pump_session(session);
        Ok(session_json(session))
    }

    pub fn interrupt_session(&mut self, body: &Value) -> Result<Value, WorkbenchError> {
        let session_id = body_string(body, "sessionId", MAX_STORED_SESSION_ID_LENGTH)?;
        let session = self
            .sessions
            .get_mut(&session_id)
            .ok_or(WorkbenchError::new("unknown_session"))?;
        let result = match &mut session.live {
            LiveSession::Hermes { adapter, live_id } => adapter
                .interrupt(live_id)
                .map_err(|error| WorkbenchError::new(error.code())),
            LiveSession::Codex {
                supervisor,
                active_turn,
            } => {
                let turn = active_turn
                    .as_deref()
                    .ok_or(WorkbenchError::new("interrupt_unavailable"))?;
                supervisor
                    .cancel(turn, DEFAULT_DEADLINE)
                    .map_err(map_codex_error)?;
                *active_turn = None;
                Ok(())
            }
        };

        if let Err(error) = result {
            session.status = "error".to_owned();
            push_error(session, error.code());
            return Err(error);
        }
        pump_session(session);
        Ok(session_json(session))
    }

    fn workspace_from_body(&self, body: &Value) -> Result<&Workspace, WorkbenchError> {
        let workspace_id = body_string(body, "workspaceId", MAX_STORED_SESSION_ID_LENGTH)?;
        self.workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or(WorkbenchError::new("unknown_workspace"))
    }

    fn has_provider_session(
        &self,
        workspace_id: &str,
        provider: Provider,
        provider_session_id: &str,
    ) -> bool {
        self.sessions.values().any(|session| {
            session.workspace_id == workspace_id
                && session.provider == provider
                && session.provider_session_id == provider_session_id
        })
    }

    fn approved_cwd(&self, raw: &str) -> Result<PathBuf, WorkbenchError> {
        let candidate = Path::new(raw);
        if !candidate.is_absolute() {
            return Err(WorkbenchError::new("workspace_cwd_not_absolute"));
        }
        let cwd = canonical_directory(candidate)?;
        if self
            .approved_roots
            .iter()
            .any(|approved_root| cwd.starts_with(approved_root))
        {
            Ok(cwd)
        } else {
            Err(WorkbenchError::new("workspace_cwd_not_approved"))
        }
    }

    fn create_provider_session(
        &mut self,
        provider: Provider,
        workspace: &Workspace,
        resume: Option<&str>,
    ) -> Result<StoredSession, WorkbenchError> {
        ensure_session_capacity(self.sessions.len())?;
        let (provider_session_id, status, live) = match provider {
            Provider::Hermes => {
                let endpoint = self
                    .hermes_endpoint
                    .clone()
                    .ok_or(WorkbenchError::new("hermes_not_configured"))?;
                let mut adapter = HermesSessionAdapter::connect(endpoint)
                    .map_err(|error| WorkbenchError::new(error.code()))?;
                let created = match resume {
                    Some(stored_id) => adapter
                        .resume(stored_id)
                        .map_err(|error| WorkbenchError::new(error.code()))?,
                    None => adapter
                        .create(Some(path_string(&workspace.cwd)?))
                        .map_err(|error| WorkbenchError::new(error.code()))?,
                };
                (
                    created.stored_id,
                    "idle".to_owned(),
                    LiveSession::Hermes {
                        adapter,
                        live_id: created.live_id,
                    },
                )
            }
            Provider::Codex => {
                let transport =
                    ProcessTransport::spawn(Some(&workspace.cwd)).map_err(map_codex_error)?;
                let mut supervisor = Supervisor::new(transport);
                let provider_session_id = match resume {
                    Some(stored_id) => supervisor
                        .resume_in_cwd(stored_id, path_string(&workspace.cwd)?, DEFAULT_DEADLINE)
                        .map_err(map_codex_error)?,
                    None => supervisor
                        .create(DEFAULT_DEADLINE)
                        .map_err(map_codex_error)?,
                }
                .to_string();
                (
                    provider_session_id,
                    "idle".to_owned(),
                    LiveSession::Codex {
                        supervisor,
                        active_turn: None,
                    },
                )
            }
        };

        let mut session = StoredSession {
            id: format!("session-{}", self.next_session_id),
            workspace_id: workspace.id.clone(),
            provider,
            provider_session_id,
            status,
            events: VecDeque::new(),
            next_event_sequence: 1,
            reported_dropped: 0,
            live,
        };
        self.next_session_id += 1;
        push_session_event(
            &mut session,
            ChatRole::System,
            ChatCategory::Status,
            match resume {
                Some(_) => "session.resumed",
                None => "session.started",
            },
            "Provider session connected.",
            None,
        );
        pump_session(&mut session);
        Ok(session)
    }

    fn pump_all(&mut self) {
        for session in self.sessions.values_mut() {
            pump_session(session);
        }
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, WorkbenchError> {
    let path = fs::canonicalize(path).map_err(|_| WorkbenchError::new("workspace_cwd_invalid"))?;
    if path.is_dir() {
        Ok(path)
    } else {
        Err(WorkbenchError::new("workspace_cwd_invalid"))
    }
}

fn path_string(path: &Path) -> Result<&str, WorkbenchError> {
    path.to_str()
        .filter(|path| !path.is_empty() && path.len() <= MAX_CWD_LENGTH)
        .ok_or(WorkbenchError::new("workspace_cwd_invalid"))
}

fn body_string(body: &Value, field: &str, max_length: usize) -> Result<String, WorkbenchError> {
    let value = body
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= max_length)
        .ok_or(WorkbenchError::new("invalid_request"))?;
    Ok(value.to_owned())
}

fn ensure_session_capacity(session_count: usize) -> Result<(), WorkbenchError> {
    if session_count < MAX_STORED_SESSIONS {
        Ok(())
    } else {
        Err(WorkbenchError::new("session_limit_reached"))
    }
}

fn map_codex_error(error: SessionError) -> WorkbenchError {
    WorkbenchError::new(error.code())
}

fn pump_session(session: &mut StoredSession) {
    let mut pump_error_code = None;
    match &mut session.live {
        LiveSession::Hermes { adapter, .. } => {
            let was_error = session.status == "error";
            let pump_error = adapter.pump(Duration::from_millis(1)).err();
            session.status = match adapter.status() {
                relay_hermes_session::SessionStatus::Idle => "idle",
                relay_hermes_session::SessionStatus::Working => "working",
                relay_hermes_session::SessionStatus::Degraded => "degraded",
                relay_hermes_session::SessionStatus::Failed => "error",
            }
            .to_owned();
            if let Some(error) = pump_error
                && !matches!(error, relay_hermes_session::AdapterError::Timeout)
                && !was_error
            {
                pump_error_code = Some(error.code());
            }
            for event in adapter.drain_events() {
                push_provider_event(
                    &mut session.events,
                    &mut session.next_event_sequence,
                    event.rich,
                );
            }
            push_pressure_if_new(
                &mut session.events,
                &mut session.next_event_sequence,
                &mut session.reported_dropped,
                adapter.stream_signals().dropped,
            );
        }
        LiveSession::Codex {
            supervisor,
            active_turn,
        } => {
            supervisor.pump();
            session.status = codex_status(supervisor.status()).to_owned();
            while let Some(event) = supervisor.next_event() {
                push_provider_event(
                    &mut session.events,
                    &mut session.next_event_sequence,
                    event.rich,
                );
            }
            if supervisor.signals().backpressured {
                push_pressure_if_new(
                    &mut session.events,
                    &mut session.next_event_sequence,
                    &mut session.reported_dropped,
                    supervisor.signals().dropped,
                );
            }
            if session.status == "idle" {
                *active_turn = None;
            }
        }
    }

    if let Some(error_code) = pump_error_code {
        push_error(session, error_code);
    }
}

fn codex_status(status: &relay_session::SessionStatus) -> &'static str {
    match status {
        relay_session::SessionStatus::Starting => "starting",
        relay_session::SessionStatus::Idle => "idle",
        relay_session::SessionStatus::Working => "working",
        relay_session::SessionStatus::Degraded(_) => "degraded",
        relay_session::SessionStatus::Failed(_) => "error",
        relay_session::SessionStatus::Closed => "closed",
    }
}

fn workspace_json(workspace: &Workspace) -> Value {
    json!({
        "id": workspace.id,
        "name": workspace.name,
        "cwd": workspace.cwd,
    })
}

fn session_json(session: &StoredSession) -> Value {
    json!({
        "id": session.id,
        "workspaceId": session.workspace_id,
        "provider": session.provider.code(),
        "providerSessionId": session.provider_session_id,
        "status": session.status,
        "events": session.events.iter().map(|event| json!({
            "role": event.role.code(),
            "kind": event.category.code(),
            "label": event.label,
            "text": event.text,
            "sequence": event.sequence,
            "signal": event.signal.map(ChatSignal::code),
        })).collect::<Vec<_>>(),
    })
}

fn push_event(events: &mut VecDeque<RichChatEvent>, event: RichChatEvent) {
    if events.len() >= MAX_STORED_EVENTS {
        events.pop_front();
    }
    events.push_back(event);
}

fn push_session_event(
    session: &mut StoredSession,
    role: ChatRole,
    category: ChatCategory,
    label: &str,
    text: impl Into<String>,
    signal: Option<ChatSignal>,
) {
    let event = RichChatEvent::new(
        session.next_event_sequence,
        role,
        category,
        label,
        text,
        signal,
    );
    session.next_event_sequence += 1;
    push_event(&mut session.events, event);
}

fn push_provider_event(
    events: &mut VecDeque<RichChatEvent>,
    next_sequence: &mut u64,
    mut event: RichChatEvent,
) {
    event.sequence = *next_sequence;
    *next_sequence += 1;
    push_event(events, event);
}

fn push_pressure_if_new(
    events: &mut VecDeque<RichChatEvent>,
    next_sequence: &mut u64,
    reported_dropped: &mut u64,
    dropped: u64,
) {
    if dropped <= *reported_dropped {
        return;
    }
    *reported_dropped = dropped;
    let event = RichChatEvent::new(
        *next_sequence,
        ChatRole::System,
        ChatCategory::Error,
        "stream.queue_pressure",
        format!("Provider event queue dropped {dropped} event(s)."),
        Some(ChatSignal::QueuePressure),
    );
    *next_sequence += 1;
    push_event(events, event);
}

fn push_error(session: &mut StoredSession, code: &str) {
    push_session_event(
        session,
        ChatRole::System,
        ChatCategory::Error,
        "provider.error",
        format!("Provider request failed: {code}."),
        Some(ChatSignal::Degraded),
    );
}

#[cfg(test)]
mod tests {
    use std::{env, fs};

    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            env::temp_dir().join(format!("relay-hub-workbench-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested")).expect("test directory");
        root
    }

    #[test]
    fn workbench_rejects_a_second_authenticated_browser_session() {
        let root = temp_root("owner");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        assert_eq!(workbench.authorize("owner-session"), Ok(()));
        assert_eq!(workbench.authorize("owner-session"), Ok(()));
        assert_eq!(
            workbench.authorize("different-session"),
            Err(WorkbenchError::new("workbench_owner_mismatch"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_addition_canonicalizes_and_rejects_unapproved_cwds() {
        let root = temp_root("approval");
        let mut workbench = Workbench::new(vec![root.clone()], None).expect("workbench config");
        let nested = root.join("nested");
        let workspace = workbench
            .add_workspace(&json!({ "cwd": nested.to_string_lossy() }))
            .expect("approved workspace");
        assert_eq!(
            workspace["cwd"],
            fs::canonicalize(&nested)
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(
            workbench
                .add_workspace(&json!({ "cwd": "/" }))
                .expect_err("root is not within this approval"),
            WorkbenchError::new("workspace_cwd_not_approved")
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn duplicate_workspace_add_is_idempotent() {
        let root = temp_root("duplicate");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        let first = workbench
            .add_workspace(&json!({"cwd": root.to_string_lossy(), "name": "First"}))
            .unwrap();
        let second = workbench
            .add_workspace(
                &json!({"cwd": root.join("nested/..").to_string_lossy(), "name": "Other"}),
            )
            .unwrap();
        assert_eq!(first["id"], second["id"]);
        assert_eq!(
            workbench.snapshot()["workspaces"].as_array().unwrap().len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn workspace_selection_is_explicit_and_cannot_select_unknown_ids() {
        let root = temp_root("selection");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        let workspace = workbench
            .add_workspace(&json!({"cwd": root.to_string_lossy()}))
            .unwrap();

        assert_eq!(
            workbench.select_workspace(&json!({"workspaceId": workspace["id"]})),
            Ok(workspace.clone())
        );
        assert_eq!(workbench.snapshot()["selectedWorkspaceId"], workspace["id"]);
        assert_eq!(
            workbench.select_workspace(&json!({"workspaceId": "not-owned"})),
            Err(WorkbenchError::new("unknown_workspace"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_workspace_fails_before_provider_selection_or_spawn() {
        let root = temp_root("before-spawn");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        assert_eq!(
            workbench.start_session(&json!({"workspaceId": "missing", "provider": "codex"})),
            Err(WorkbenchError::new("unknown_workspace"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_capacity_fails_closed_before_provider_creation() {
        assert_eq!(ensure_session_capacity(MAX_STORED_SESSIONS - 1), Ok(()));
        assert_eq!(
            ensure_session_capacity(MAX_STORED_SESSIONS),
            Err(WorkbenchError::new("session_limit_reached"))
        );
    }

    #[test]
    fn hermes_resume_rejects_a_client_supplied_unknown_provider_session() {
        let root = temp_root("hermes-resume");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        let workspace = workbench
            .add_workspace(&json!({"cwd": root.to_string_lossy()}))
            .unwrap();

        assert_eq!(
            workbench.resume_session(&json!({
                "workspaceId": workspace["id"],
                "provider": "hermes",
                "providerSessionId": "untrusted",
            })),
            Err(WorkbenchError::new("unknown_provider_session"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_start_never_substitutes_a_missing_hermes_adapter() {
        let root = temp_root("hermes");
        let mut workbench = Workbench::new(vec![root.clone()], None).expect("workbench config");
        let workspace = workbench
            .add_workspace(&json!({ "cwd": root.to_string_lossy() }))
            .expect("approved workspace");
        assert_eq!(
            workbench
                .start_session(&json!({ "workspaceId": workspace["id"], "provider": "hermes" }))
                .expect_err("missing endpoint must be visible"),
            WorkbenchError::new("hermes_not_configured")
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }
}
