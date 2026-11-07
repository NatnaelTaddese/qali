//! The cookie jar's home in the macOS Keychain (Credential Manager / Secret Service elsewhere).

use std::collections::BTreeMap;

use super::cookie_jar::Entry;

pub struct Store {
    entry: Option<keyring::Entry>,
}

impl Store {
    pub fn keychain(service: &str, account: &str) -> Self {
        let entry = keyring::Entry::new(service, account)
            .inspect_err(|e| eprintln!("qali: keychain unavailable ({e}); the session won't survive a relaunch"))
            .ok();
        Store { entry }
    }

    pub fn load(&self) -> Option<BTreeMap<String, Entry>> {
        let json = self.entry.as_ref()?.get_password().ok()?;
        serde_json::from_str(&json).ok()
    }

    pub fn save(&self, entries: &BTreeMap<String, Entry>) {
        let Some(entry) = &self.entry else { return };
        if let Ok(json) = serde_json::to_string(entries)
            && let Err(e) = entry.set_password(&json)
        {
            eprintln!("qali: couldn't save the session to the keychain: {e}");
        }
    }

    pub fn delete(&self) {
        if let Some(entry) = &self.entry {
            let _ = entry.delete_credential();
        }
    }
}
