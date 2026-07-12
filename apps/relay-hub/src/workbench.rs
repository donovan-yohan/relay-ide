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
const MAX_RECENT_CLAUDE_SESSIONS: usize = 16;
const MAX_DIRECTORY_ENTRIES: usize = 128;
const MAX_DIRECTORY_SCAN: usize = 1_024;

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
    Claude,
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
            Self::Claude => "claude",
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
    Claude,
    #[cfg(test)]
    RetainedTerminalFixture,
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
    pub fn owner_session(&self) -> Option<&str> {
        self.owner_session.as_deref()
    }

    pub fn authorize(
        &mut self,
        session: &str,
        owner_session_is_active: bool,
    ) -> Result<(), WorkbenchError> {
        match self.owner_session.as_deref() {
            Some(owner) if owner == session => Ok(()),
            Some(_) if !owner_session_is_active => {
                self.owner_session = Some(session.to_owned());
                self.workspaces.clear();
                self.selected_workspace_id = None;
                self.sessions.clear();
                Ok(())
            }
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
                "claude": true,
            },
        })
    }

    /// List approved roots or one approved directory without ever returning an
    /// entry whose canonical target escapes the configured node-local roots.
    pub fn browse_directories(&self, body: &Value) -> Result<Value, WorkbenchError> {
        let Some(raw_path) = body.get("path") else {
            let directories = self
                .approved_roots
                .iter()
                .take(MAX_DIRECTORY_ENTRIES)
                .map(directory_json)
                .collect::<Vec<_>>();
            return Ok(json!({
                "path": Value::Null,
                "parent": Value::Null,
                "directories": directories,
            }));
        };
        let raw_path = raw_path
            .as_str()
            .filter(|path| !path.is_empty() && path.len() <= MAX_CWD_LENGTH)
            .ok_or(WorkbenchError::new("invalid_request"))?;
        let directory = self.approved_cwd(raw_path)?;
        let entries =
            fs::read_dir(&directory).map_err(|_| WorkbenchError::new("workspace_cwd_invalid"))?;
        let mut directories = Vec::with_capacity(MAX_DIRECTORY_ENTRIES);
        for entry in entries.take(MAX_DIRECTORY_SCAN) {
            let Ok(entry) = entry else { continue };
            let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            if name.is_empty() || name.len() > MAX_NAME_LENGTH {
                continue;
            }
            let Ok(path) = canonical_directory(&entry.path()) else {
                continue;
            };
            if !self.is_approved_cwd(&path) {
                continue;
            }
            let insertion = directories
                .binary_search_by(|candidate: &Value| {
                    candidate["name"].as_str().unwrap_or_default().cmp(&name)
                })
                .unwrap_or_else(|index| index);
            directories.insert(insertion, json!({"name": name, "path": path}));
            if directories.len() > MAX_DIRECTORY_ENTRIES {
                directories.pop();
            }
        }
        let parent = if self.approved_roots.iter().any(|root| root == &directory) {
            Value::Null
        } else {
            directory
                .parent()
                .filter(|parent| self.is_approved_cwd(parent))
                .map(|parent| json!(parent))
                .unwrap_or(Value::Null)
        };
        Ok(json!({
            "path": directory,
            "parent": parent,
            "directories": directories,
        }))
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

    /// Resolve a browser-supplied opaque Workspace id to the current trusted
    /// canonical CWD. The raw path never enters the Claude launch request.
    pub fn trusted_claude_workspace(
        &mut self,
        body: &Value,
    ) -> Result<(String, PathBuf), WorkbenchError> {
        let workspace = self.workspace_from_body(body)?;
        let cwd = canonical_directory(&workspace.cwd)?;
        if !self.is_approved_cwd(&cwd) {
            return Err(WorkbenchError::new("workspace_cwd_not_approved"));
        }
        if cwd != workspace.cwd {
            return Err(WorkbenchError::new("workspace_cwd_invalid"));
        }
        let workspace_id = workspace.id.clone();
        self.prune_closed_claude_history();
        self.ensure_provider_session_capacity()?;
        Ok((workspace_id, cwd))
    }

    pub fn register_claude_session(
        &mut self,
        workspace_id: &str,
        provider_session_id: &str,
        status: &str,
    ) -> Result<Value, WorkbenchError> {
        self.ensure_provider_session_capacity()?;
        if !valid_claude_session_id(provider_session_id) || !valid_claude_status(status) {
            return Err(WorkbenchError::new("invalid_request"));
        }
        if !self
            .workspaces
            .iter()
            .any(|workspace| workspace.id == workspace_id)
        {
            return Err(WorkbenchError::new("unknown_workspace"));
        }
        if let Some(existing) = self.sessions.values().find(|session| {
            session.provider == Provider::Claude
                && session.provider_session_id == provider_session_id
        }) {
            return Ok(session_json(existing));
        }
        let session = StoredSession {
            id: format!("claude-session-{}", self.next_session_id),
            workspace_id: workspace_id.to_owned(),
            provider: Provider::Claude,
            provider_session_id: provider_session_id.to_owned(),
            status: status.to_owned(),
            events: VecDeque::new(),
            next_event_sequence: 1,
            reported_dropped: 0,
            live: LiveSession::Claude,
        };
        self.next_session_id += 1;
        let response = session_json(&session);
        self.sessions.insert(session.id.clone(), session);
        Ok(response)
    }

    pub fn update_claude_status(&mut self, provider_session_id: &str, status: &str) {
        if !valid_claude_status(status) {
            return;
        }
        if let Some(session) = self.sessions.values_mut().find(|session| {
            session.provider == Provider::Claude
                && session.provider_session_id == provider_session_id
        }) {
            session.status = status.to_owned();
        }
    }

    pub fn sessions_snapshot(&mut self) -> Value {
        self.pump_all();
        let mut sessions = self.sessions.values().collect::<Vec<_>>();
        sessions.sort_by_key(|session| std::cmp::Reverse(stored_session_order(&session.id)));
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
        if !self.has_provider_session(&workspace.id, provider, &stored_id) {
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
            LiveSession::Claude => Err(WorkbenchError::new("session_terminal")),
            #[cfg(test)]
            LiveSession::RetainedTerminalFixture => Err(WorkbenchError::new("session_terminal")),
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
            LiveSession::Claude => Err(WorkbenchError::new("session_terminal")),
            #[cfg(test)]
            LiveSession::RetainedTerminalFixture => Err(WorkbenchError::new("session_terminal")),
        };

        if let Err(error) = result {
            session.status = "error".to_owned();
            push_error(session, error.code());
            return Err(error);
        }
        pump_session(session);
        Ok(session_json(session))
    }

    pub fn close_session(&mut self, body: &Value) -> Result<Value, WorkbenchError> {
        let session_id = body_string(body, "sessionId", MAX_STORED_SESSION_ID_LENGTH)?;
        if self
            .sessions
            .get(&session_id)
            .is_some_and(|session| session.provider == Provider::Claude)
        {
            return Err(WorkbenchError::new("session_terminal"));
        }
        let mut session = self
            .sessions
            .remove(&session_id)
            .ok_or(WorkbenchError::new("unknown_session"))?;
        if let LiveSession::Codex { supervisor, .. } = &mut session.live {
            supervisor.close();
        }
        Ok(json!({"id": session.id, "status": "closed"}))
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
        if self.is_approved_cwd(&cwd) {
            Ok(cwd)
        } else {
            Err(WorkbenchError::new("workspace_cwd_not_approved"))
        }
    }

    fn is_approved_cwd(&self, cwd: &Path) -> bool {
        self.approved_roots
            .iter()
            .any(|approved_root| cwd.starts_with(approved_root))
    }

    fn create_provider_session(
        &mut self,
        provider: Provider,
        workspace: &Workspace,
        resume: Option<&str>,
    ) -> Result<StoredSession, WorkbenchError> {
        self.ensure_provider_session_capacity()?;
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
            Provider::Claude => return Err(WorkbenchError::new("session_terminal")),
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

    fn ensure_provider_session_capacity(&self) -> Result<(), WorkbenchError> {
        ensure_session_capacity(self.sessions.len())
    }

    fn prune_closed_claude_history(&mut self) {
        while self
            .sessions
            .values()
            .filter(|session| session.provider == Provider::Claude)
            .count()
            >= MAX_RECENT_CLAUDE_SESSIONS
        {
            let oldest = self
                .sessions
                .iter()
                .filter(|(_, session)| {
                    session.provider == Provider::Claude && session.status == "closed"
                })
                .min_by_key(|(_, session)| stored_session_order(&session.id))
                .map(|(id, _)| id.clone());
            let Some(oldest) = oldest else { return };
            self.sessions.remove(&oldest);
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
        LiveSession::Claude => {}
        #[cfg(test)]
        LiveSession::RetainedTerminalFixture => {}
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

fn directory_json(path: &PathBuf) -> Value {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_str().unwrap_or("/"));
    json!({"name": name, "path": path})
}

fn valid_claude_session_id(value: &str) -> bool {
    value.starts_with("claude-pty-")
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_claude_status(value: &str) -> bool {
    matches!(
        value,
        "starting" | "running" | "exited" | "closing" | "closed"
    )
}

fn stored_session_order(id: &str) -> u64 {
    id.rsplit_once('-')
        .and_then(|(_, suffix)| suffix.parse().ok())
        .unwrap_or(u64::MAX)
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

    fn retained_terminal_session(index: usize) -> StoredSession {
        StoredSession {
            id: format!("session-{index}"),
            workspace_id: "workspace-retained".to_owned(),
            provider: Provider::Codex,
            provider_session_id: format!("provider-terminal-{index}"),
            status: "error".to_owned(),
            events: VecDeque::new(),
            next_event_sequence: 1,
            reported_dropped: 0,
            live: LiveSession::RetainedTerminalFixture,
        }
    }

    #[test]
    fn workbench_rejects_a_second_authenticated_browser_session() {
        let root = temp_root("owner");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        assert_eq!(workbench.authorize("owner-session", true), Ok(()));
        assert_eq!(workbench.authorize("owner-session", true), Ok(()));
        assert_eq!(
            workbench.authorize("different-session", true),
            Err(WorkbenchError::new("workbench_owner_mismatch"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn expired_owner_is_rebound_after_its_workbench_state_is_cleared() {
        let root = temp_root("owner-rebind");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        workbench.authorize("expired-owner", true).unwrap();
        workbench
            .add_workspace(&json!({"cwd": root.to_string_lossy()}))
            .unwrap();

        assert_eq!(workbench.authorize("replacement-owner", false), Ok(()));
        assert_eq!(workbench.owner_session(), Some("replacement-owner"));
        assert!(
            workbench.snapshot()["workspaces"]
                .as_array()
                .unwrap()
                .is_empty()
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
    fn directory_browsing_is_bounded_canonical_and_filters_symlink_escapes() {
        let root = temp_root("browse");
        let outside = temp_root("browse-outside");
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join("zeta")).unwrap();
        for index in 0..MAX_DIRECTORY_ENTRIES + 8 {
            fs::create_dir_all(root.join(format!("bounded-{index:03}"))).unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        let workbench = Workbench::new(vec![root.clone()], None).unwrap();

        let roots = workbench.browse_directories(&json!({})).unwrap();
        assert_eq!(roots["path"], Value::Null);
        assert_eq!(roots["directories"].as_array().unwrap().len(), 1);

        let listing = workbench
            .browse_directories(&json!({"path": root.to_string_lossy()}))
            .unwrap();
        let names = listing["directories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), MAX_DIRECTORY_ENTRIES);
        assert!(names.windows(2).all(|pair| pair[0] <= pair[1]));
        #[cfg(unix)]
        assert!(!names.contains(&"escape"));
        assert_eq!(listing["parent"], Value::Null);

        #[cfg(unix)]
        assert_eq!(
            workbench.browse_directories(&json!({
                "path": root.join("escape").to_string_lossy()
            })),
            Err(WorkbenchError::new("workspace_cwd_not_approved"))
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn claude_launch_resolves_only_a_current_approved_workspace_binding() {
        let root = temp_root("claude-launch");
        let outside = temp_root("claude-launch-outside");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        let workspace = workbench
            .add_workspace(&json!({"cwd": root.join("nested").to_string_lossy()}))
            .unwrap();

        let (workspace_id, cwd) = workbench
            .trusted_claude_workspace(&json!({
                "workspaceId": workspace["id"],
                "cwd": outside.to_string_lossy(),
                "command": "/bin/sh",
                "HOME": "/tmp/browser-home",
                "PATH": "/tmp/browser-bin"
            }))
            .unwrap();
        assert_eq!(workspace_id, workspace["id"]);
        assert_eq!(cwd, fs::canonicalize(root.join("nested")).unwrap());
        assert_eq!(
            workbench.trusted_claude_workspace(&json!({"workspaceId": "unknown"})),
            Err(WorkbenchError::new("unknown_workspace"))
        );

        workbench.workspaces[0].cwd = outside.clone();
        assert_eq!(
            workbench.trusted_claude_workspace(&json!({"workspaceId": workspace["id"]})),
            Err(WorkbenchError::new("workspace_cwd_not_approved"))
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn claude_session_metadata_is_bounded_and_terminal_control_stays_outside_workbench() {
        let root = temp_root("claude-metadata");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        let workspace = workbench
            .add_workspace(&json!({"cwd": root.to_string_lossy()}))
            .unwrap();
        let session = workbench
            .register_claude_session(
                workspace["id"].as_str().unwrap(),
                "claude-pty-42",
                "running",
            )
            .unwrap();

        assert_eq!(session["provider"], "claude");
        assert_eq!(session["providerSessionId"], "claude-pty-42");
        assert_eq!(session["events"], json!([]));
        assert_eq!(
            workbench.close_session(&json!({"sessionId": session["id"]})),
            Err(WorkbenchError::new("session_terminal"))
        );
        workbench.update_claude_status("claude-pty-42", "closed");
        assert_eq!(workbench.sessions_snapshot()[0]["status"], "closed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn closed_claude_history_is_pruned_without_evicting_live_or_chat_sessions() {
        let root = temp_root("claude-history");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        let workspace = workbench
            .add_workspace(&json!({"cwd": root.to_string_lossy()}))
            .unwrap();
        for index in 0..MAX_RECENT_CLAUDE_SESSIONS {
            workbench
                .register_claude_session(
                    workspace["id"].as_str().unwrap(),
                    &format!("claude-pty-{index}"),
                    "closed",
                )
                .unwrap();
        }

        workbench
            .trusted_claude_workspace(&json!({"workspaceId": workspace["id"]}))
            .unwrap();
        assert_eq!(workbench.sessions.len(), MAX_RECENT_CLAUDE_SESSIONS - 1);
        assert!(!workbench.sessions.values().any(|session| {
            session.provider == Provider::Claude && session.provider_session_id == "claude-pty-0"
        }));
        fs::remove_dir_all(root).unwrap();
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
    fn failed_sessions_remain_visible_and_resume_eligible_until_the_bounded_cap() {
        let root = temp_root("retained-terminal");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        for index in 0..MAX_STORED_SESSIONS {
            let session = retained_terminal_session(index);
            workbench.sessions.insert(session.id.clone(), session);
        }

        let snapshot = workbench.sessions_snapshot();
        assert_eq!(snapshot.as_array().unwrap().len(), MAX_STORED_SESSIONS);
        assert!(
            snapshot
                .as_array()
                .unwrap()
                .iter()
                .all(|session| session["status"] == "error"),
            "failed provider history must remain visible"
        );
        assert!(
            workbench.has_provider_session(
                "workspace-retained",
                Provider::Codex,
                "provider-terminal-0"
            ),
            "a retained provider ID remains eligible for explicit resume"
        );
        assert_eq!(
            workbench.ensure_provider_session_capacity(),
            Err(WorkbenchError::new("session_limit_reached")),
            "retention must remain bounded instead of evicting failed history"
        );
        assert_eq!(workbench.sessions.len(), MAX_STORED_SESSIONS);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resume_rejects_a_client_supplied_unknown_provider_session() {
        let root = temp_root("hermes-resume");
        let mut workbench = Workbench::new(vec![root.clone()], None).unwrap();
        let workspace = workbench
            .add_workspace(&json!({"cwd": root.to_string_lossy()}))
            .unwrap();

        for provider in ["hermes", "codex"] {
            assert_eq!(
                workbench.resume_session(&json!({
                    "workspaceId": workspace["id"],
                    "provider": provider,
                    "providerSessionId": "untrusted",
                })),
                Err(WorkbenchError::new("unknown_provider_session"))
            );
        }
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
