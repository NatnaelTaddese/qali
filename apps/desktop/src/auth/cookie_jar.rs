//! The Better Auth session cookies.
//!
//! A port of `@better-auth/expo`'s cookie handling (and of the iOS app's
//! `CookieJar.swift`): cookies are stored by name with an optional expiry, and
//! every request sends the unexpired ones as one `Cookie` header. reqwest's own
//! cookie store stays off on purpose, because the session cookie also arrives
//! in the `qali://` callback's query string, not only in responses.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::store::Store;

pub const SESSION_COOKIES: [&str; 2] = ["__Secure-better-auth.session_token", "better-auth.session_token"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub value: String,
    /// Seconds since the Unix epoch; `None` lasts until the server replaces it.
    pub expires: Option<u64>,
}

pub struct CookieJar {
    entries: Mutex<BTreeMap<String, Entry>>,
    store: Option<Store>,
}

impl CookieJar {
    /// A jar that saves to (and starts from) `store`.
    pub fn persistent(store: Store) -> Self {
        let entries = store.load().unwrap_or_default();
        CookieJar { entries: Mutex::new(entries), store: Some(store) }
    }

    /// A jar that lives only in memory (tests).
    #[cfg(test)]
    pub fn in_memory() -> Self {
        CookieJar { entries: Mutex::new(BTreeMap::new()), store: None }
    }

    /// The `Cookie` request header, or `None` when nothing unexpired is stored.
    pub fn header(&self, now: SystemTime) -> Option<String> {
        let now = epoch(now);
        let entries = self.entries.lock().unwrap();
        let pairs: Vec<String> = entries
            .iter()
            .filter(|(_, e)| e.expires.is_none_or(|t| t > now))
            .map(|(name, e)| format!("{name}={}", e.value))
            .collect();
        (!pairs.is_empty()).then(|| pairs.join("; "))
    }

    pub fn value(&self, name: &str) -> Option<String> {
        self.entries.lock().unwrap().get(name).map(|e| e.value.clone())
    }

    /// True when a Better Auth session token is stored (secure-prefixed or not).
    pub fn has_session(&self) -> bool {
        let entries = self.entries.lock().unwrap();
        SESSION_COOKIES.iter().any(|name| entries.contains_key(*name))
    }

    /// Merges a (possibly comma-joined) `Set-Cookie` header. Returns true when the jar changed.
    pub fn merge(&self, set_cookie: &str, now: SystemTime) -> bool {
        let mut entries = self.entries.lock().unwrap();
        let before = entries.clone();
        let now_s = epoch(now);
        for cookie in parse(set_cookie) {
            let expires = match cookie.max_age {
                Some(max_age) => Some(now_s.saturating_add_signed(max_age)),
                None => cookie.expires.map(epoch),
            };
            let gone = cookie.max_age.is_some_and(|m| m <= 0) || expires.is_some_and(|t| t <= now_s);
            if gone {
                entries.remove(&cookie.name);
            } else {
                entries.insert(cookie.name, Entry { value: cookie.value, expires });
            }
        }
        let changed = *entries != before;
        if changed && let Some(store) = &self.store {
            store.save(&entries);
        }
        changed
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
        if let Some(store) = &self.store {
            store.delete();
        }
    }
}

fn epoch(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs()
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParsedCookie {
    pub name: String,
    pub value: String,
    pub max_age: Option<i64>,
    pub expires: Option<SystemTime>,
}

/// Better Auth's `parseSetCookieHeader`: the name, the percent-decoded value, and the expiry
/// attributes of each cookie in the header.
pub fn parse(header: &str) -> Vec<ParsedCookie> {
    split(header)
        .into_iter()
        .filter_map(|part| {
            let mut segments = part.split(';').map(str::trim);
            let (name, raw) = segments.next()?.split_once('=')?;
            if name.is_empty() {
                return None;
            }
            let raw = raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(raw);
            let value = percent_decode(raw).unwrap_or_else(|| raw.to_string());
            let mut cookie = ParsedCookie { name: name.to_string(), value, max_age: None, expires: None };
            for attribute in segments {
                let (key, value) = attribute.split_once('=').unwrap_or((attribute, ""));
                match key.trim().to_ascii_lowercase().as_str() {
                    "max-age" => cookie.max_age = value.trim().parse().ok(),
                    "expires" => cookie.expires = httpdate::parse_http_date(value.trim()).ok(),
                    _ => {}
                }
            }
            Some(cookie)
        })
        .collect()
}

/// Better Auth's `splitSetCookieHeader`: split on commas that start a new `name=` pair, so
/// `Expires=Wed, 21 Oct 2026 …` stays in one piece.
pub fn split(header: &str) -> Vec<String> {
    let chars: Vec<char> = header.chars().collect();
    let mut result = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            while j < chars.len() && !matches!(chars[j], '=' | ';' | ',') {
                j += 1;
            }
            if j < chars.len() && chars[j] == '=' {
                let part: String = chars[start..i].iter().collect();
                if !part.trim().is_empty() {
                    result.push(part.trim().to_string());
                }
                start = i + 1;
                while start < chars.len() && chars[start] == ' ' {
                    start += 1;
                }
                i = start;
                continue;
            }
        }
        i += 1;
    }
    let last: String = chars[start.min(chars.len())..].iter().collect();
    if !last.trim().is_empty() {
        result.push(last.trim().to_string());
    }
    result
}

/// `decodeURIComponent`: `None` when an escape is malformed or the bytes aren't UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
#[path = "cookie_jar_tests.rs"]
mod tests;
