use std::{
    collections::HashSet,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::{fs::MetadataExt, fs::OpenOptionsExt, fs::PermissionsExt},
    path::{Component, Path, PathBuf},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use webauthn_rs::prelude::Passkey;

use crate::{AuthError, AuthOrigin};

const SCHEMA_VERSION: u32 = 1;
const MAX_STORE_BYTES: u64 = 1024 * 1024;
const MAX_DURABLE_PASSKEYS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstOwnerExposure {
    Private,
    Public,
    Funnel,
    Unknown,
}

impl FirstOwnerExposure {
    pub fn parse(value: &str) -> Result<Self, AuthError> {
        match value {
            "private" => Ok(Self::Private),
            "public" => Ok(Self::Public),
            "funnel" => Ok(Self::Funnel),
            "unknown" => Ok(Self::Unknown),
            _ => Err(AuthError::ClaimExposureDenied),
        }
    }

    pub const fn permits_claim(self) -> bool {
        matches!(self, Self::Private)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct DurableCredential {
    pub credential_id: String,
    pub enrolled_at_unix_seconds: u64,
    pub passkey: Passkey,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ClaimState {
    Unclaimed,
    Claimed,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct OwnerRecord {
    schema_version: u32,
    pub generation: u64,
    pub origin: String,
    state: ClaimState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<Uuid>,
    pub passkeys: Vec<DurableCredential>,
}

impl OwnerRecord {
    pub(crate) fn unclaimed(origin: &AuthOrigin, generation: u64) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            generation,
            origin: origin.as_str().to_owned(),
            state: ClaimState::Unclaimed,
            owner_id: None,
            passkeys: Vec::new(),
        }
    }

    pub(crate) fn is_claimed(&self) -> bool {
        matches!(self.state, ClaimState::Claimed)
    }

    pub(crate) fn claim(&mut self, owner_id: Uuid) {
        self.state = ClaimState::Claimed;
        self.owner_id = Some(owner_id);
    }

    fn validate(&self, origin: &AuthOrigin) -> Result<(), AuthError> {
        if self.schema_version != SCHEMA_VERSION
            || self.generation == 0
            || self.origin != origin.as_str()
            || AuthOrigin::parse(&self.origin).map(|value| value.as_str().to_owned())
                != Ok(self.origin.clone())
        {
            return Err(AuthError::OwnerStoreUnavailable);
        }
        if self.passkeys.len() > MAX_DURABLE_PASSKEYS
            || self.passkeys.iter().any(|credential| {
                credential.credential_id.is_empty()
                    || credential.credential_id.len() > 64
                    || !credential.credential_id.is_ascii()
                    || credential.enrolled_at_unix_seconds == 0
            })
            || self
                .passkeys
                .iter()
                .map(|credential| credential.credential_id.as_str())
                .collect::<HashSet<_>>()
                .len()
                != self.passkeys.len()
        {
            return Err(AuthError::OwnerStoreUnavailable);
        }
        match (&self.state, self.owner_id, self.passkeys.is_empty()) {
            (ClaimState::Unclaimed, None, true) => Ok(()),
            (ClaimState::Claimed, Some(_), false) => Ok(()),
            _ => Err(AuthError::OwnerStoreUnavailable),
        }
    }
}

pub struct OwnerStore {
    path: PathBuf,
    _lock: File,
    record: OwnerRecord,
    unavailable: bool,
}

impl OwnerStore {
    pub fn init(path: &Path, origin: &AuthOrigin) -> Result<(), AuthError> {
        validate_absolute_path(path)?;
        prepare_private_parent(path)?;
        let lock = open_lock(path)?;
        lock.try_lock_exclusive()
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
        if fs::symlink_metadata(path).is_ok() {
            return Err(AuthError::OwnerStoreUnavailable);
        }
        let record = OwnerRecord::unclaimed(origin, 1);
        write_new(path, &record)
    }

    pub fn open(path: &Path, origin: &AuthOrigin) -> Result<Self, AuthError> {
        validate_absolute_path(path)?;
        validate_private_parent(path)?;
        let lock = open_lock(path)?;
        lock.try_lock_exclusive()
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
        validate_private_file(path)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
        let metadata = file
            .metadata()
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
        if metadata.len() == 0 || metadata.len() > MAX_STORE_BYTES {
            return Err(AuthError::OwnerStoreUnavailable);
        }
        let record: OwnerRecord =
            serde_json::from_reader(file).map_err(|_| AuthError::OwnerStoreUnavailable)?;
        record.validate(origin)?;
        Ok(Self {
            path: path.to_owned(),
            _lock: lock,
            record,
            unavailable: false,
        })
    }

    pub fn reset(path: &Path, origin: &AuthOrigin) -> Result<(), AuthError> {
        let mut store = Self::open(path, origin)?;
        let generation = store
            .record
            .generation
            .checked_add(1)
            .ok_or(AuthError::OwnerStoreUnavailable)?;
        store.persist(&OwnerRecord::unclaimed(origin, generation))
    }

    pub(crate) fn record(&self) -> &OwnerRecord {
        &self.record
    }

    pub(crate) fn is_available(&self) -> bool {
        !self.unavailable
    }

    pub(crate) fn persist(&mut self, record: &OwnerRecord) -> Result<(), AuthError> {
        if self.unavailable {
            return Err(AuthError::OwnerStoreUnavailable);
        }
        record.validate(
            &AuthOrigin::parse(&record.origin).map_err(|_| AuthError::OwnerStoreUnavailable)?,
        )?;
        let parent = self.path.parent().ok_or(AuthError::OwnerStoreUnavailable)?;
        let mut temp_name = self
            .path
            .file_name()
            .ok_or(AuthError::OwnerStoreUnavailable)?
            .to_os_string();
        temp_name.push(format!(".tmp-{}", Uuid::new_v4()));
        let temp_path = parent.join(temp_name);
        let result = (|| {
            let mut temp = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp_path)
                .map_err(|_| AuthError::OwnerStoreUnavailable)?;
            serde_json::to_writer(&mut temp, record)
                .map_err(|_| AuthError::OwnerStoreUnavailable)?;
            temp.write_all(b"\n")
                .map_err(|_| AuthError::OwnerStoreUnavailable)?;
            temp.sync_all()
                .map_err(|_| AuthError::OwnerStoreUnavailable)?;
            fs::rename(&temp_path, &self.path).map_err(|_| AuthError::OwnerStoreUnavailable)?;
            let directory = File::open(parent).map_err(|_| {
                self.unavailable = true;
                AuthError::OwnerStoreUnavailable
            })?;
            directory.sync_all().map_err(|_| {
                self.unavailable = true;
                AuthError::OwnerStoreUnavailable
            })?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
            return result;
        }
        self.record = record.clone();
        Ok(())
    }
}

fn write_new(path: &Path, record: &OwnerRecord) -> Result<(), AuthError> {
    let parent = path.parent().ok_or(AuthError::OwnerStoreUnavailable)?;
    let mut temp_name = path
        .file_name()
        .ok_or(AuthError::OwnerStoreUnavailable)?
        .to_os_string();
    temp_name.push(format!(".init-{}", Uuid::new_v4()));
    let temp_path = parent.join(temp_name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp_path)
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
        serde_json::to_writer(&mut file, record).map_err(|_| AuthError::OwnerStoreUnavailable)?;
        file.write_all(b"\n")
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
        file.sync_all()
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
        fs::hard_link(&temp_path, path).map_err(|_| AuthError::OwnerStoreUnavailable)?;
        fs::remove_file(&temp_path).map_err(|_| AuthError::OwnerStoreUnavailable)?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| AuthError::OwnerStoreUnavailable)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn prepare_private_parent(path: &Path) -> Result<(), AuthError> {
    let parent = path.parent().ok_or(AuthError::OwnerStoreUnavailable)?;
    if !parent.exists() {
        let grandparent = parent.parent().ok_or(AuthError::OwnerStoreUnavailable)?;
        validate_no_symlink_components(grandparent)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(parent)
            .map_err(|_| AuthError::OwnerStoreUnavailable)?;
    }
    validate_private_parent(path)
}

fn validate_absolute_path(path: &Path) -> Result<(), AuthError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || path.file_name().is_none()
    {
        return Err(AuthError::OwnerStoreUnavailable);
    }
    Ok(())
}

fn validate_no_symlink_components(path: &Path) -> Result<(), AuthError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| AuthError::OwnerStoreUnavailable)?;
        if metadata.file_type().is_symlink() {
            return Err(AuthError::OwnerStoreUnavailable);
        }
    }
    Ok(())
}

fn validate_private_parent(path: &Path) -> Result<(), AuthError> {
    let parent = path.parent().ok_or(AuthError::OwnerStoreUnavailable)?;
    validate_no_symlink_components(parent)?;
    let metadata = fs::metadata(parent).map_err(|_| AuthError::OwnerStoreUnavailable)?;
    if !metadata.is_dir()
        || metadata.permissions().mode() & 0o777 != 0o700
        || metadata.uid() != rustix::process::geteuid().as_raw()
    {
        return Err(AuthError::OwnerStoreUnavailable);
    }
    Ok(())
}

fn validate_private_file(path: &Path) -> Result<(), AuthError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AuthError::OwnerStoreUnavailable)?;
    if !metadata.is_file()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.nlink() != 1
    {
        return Err(AuthError::OwnerStoreUnavailable);
    }
    Ok(())
}

fn open_lock(path: &Path) -> Result<File, AuthError> {
    let mut name: OsString = path
        .file_name()
        .ok_or(AuthError::OwnerStoreUnavailable)?
        .to_os_string();
    name.push(".lock");
    let lock_path = path
        .parent()
        .ok_or(AuthError::OwnerStoreUnavailable)?
        .join(name);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(lock_path)
        .map_err(|_| AuthError::OwnerStoreUnavailable)?;
    let metadata = lock
        .metadata()
        .map_err(|_| AuthError::OwnerStoreUnavailable)?;
    if !metadata.is_file()
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.nlink() != 1
    {
        return Err(AuthError::OwnerStoreUnavailable);
    }
    Ok(lock)
}

use std::os::unix::fs::DirBuilderExt;

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("relay-owner-store-test-{}", Uuid::new_v4()));
            Self(path)
        }

        fn store(&self) -> PathBuf {
            self.0.join("owner.json")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn origin() -> AuthOrigin {
        AuthOrigin::parse("https://relay.example.test").expect("origin")
    }

    #[test]
    fn initializes_private_v1_and_never_overwrites_it() {
        let scratch = Scratch::new();
        let path = scratch.store();
        OwnerStore::init(&path, &origin()).expect("initialize");

        assert_eq!(
            fs::metadata(&scratch.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["generation"], 1);
        assert_eq!(value["origin"], "https://relay.example.test/");
        assert_eq!(value["state"], "unclaimed");
        assert!(value["owner_id"].is_null());
        assert!(value.get("recovery_hash").is_none());
        assert_eq!(value["passkeys"], serde_json::json!([]));
        assert_eq!(
            OwnerStore::init(&path, &origin()).err().unwrap(),
            AuthError::OwnerStoreUnavailable
        );
    }

    #[test]
    fn group_or_world_accessible_owner_state_fails_closed() {
        let scratch = Scratch::new();
        let path = scratch.store();
        OwnerStore::init(&path, &origin()).unwrap();

        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            OwnerStore::open(&path, &origin()).err().unwrap(),
            AuthError::OwnerStoreUnavailable
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&scratch.0, fs::Permissions::from_mode(0o750)).unwrap();
        assert_eq!(
            OwnerStore::open(&path, &origin()).err().unwrap(),
            AuthError::OwnerStoreUnavailable
        );
    }

    #[test]
    fn live_lock_blocks_reset_and_reset_advances_generation() {
        let scratch = Scratch::new();
        let path = scratch.store();
        OwnerStore::init(&path, &origin()).unwrap();
        let live = OwnerStore::open(&path, &origin()).unwrap();
        assert_eq!(
            OwnerStore::reset(&path, &origin()).err().unwrap(),
            AuthError::OwnerStoreUnavailable
        );
        drop(live);
        OwnerStore::reset(&path, &origin()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(value["generation"], 2);
        assert_eq!(value["state"], "unclaimed");
    }

    #[test]
    fn missing_corrupt_origin_mismatch_and_symlink_fail_closed() {
        let scratch = Scratch::new();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&scratch.0)
            .unwrap();
        let path = scratch.store();
        assert_eq!(
            OwnerStore::open(&path, &origin()).err().unwrap(),
            AuthError::OwnerStoreUnavailable
        );
        fs::write(&path, b"not-json").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            OwnerStore::open(&path, &origin()).err().unwrap(),
            AuthError::OwnerStoreUnavailable
        );
        fs::remove_file(&path).unwrap();
        OwnerStore::init(&path, &origin()).unwrap();
        assert_eq!(
            OwnerStore::open(
                &path,
                &AuthOrigin::parse("https://other.example.test").unwrap()
            )
            .err()
            .unwrap(),
            AuthError::OwnerStoreUnavailable
        );
        fs::rename(&path, scratch.0.join("real.json")).unwrap();
        std::os::unix::fs::symlink(scratch.0.join("real.json"), &path).unwrap();
        assert_eq!(
            OwnerStore::open(&path, &origin()).err().unwrap(),
            AuthError::OwnerStoreUnavailable
        );
    }
}
