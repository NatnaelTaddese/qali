//! The `qali:///?cookie=…` link the backend's `expo()` plugin sends the browser to once
//! Google sign-in finishes. It comes from outside the app (anyone can run
//! `open 'qali://…'`), so it is parsed strictly before anything acts on it.

use std::collections::HashMap;

use super::cookie_jar::percent_decode;

#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    /// The session's `Set-Cookie` header, to merge into the jar.
    SignedIn { set_cookie: String },
    /// Better Auth's error code (`state_mismatch`, `access_denied`, ...).
    Failed { code: String },
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallbackError {
    /// Not one of our links (`qali:///` or `qali:///sign-in`); ignore it.
    NotOurs,
    /// Ours, but carrying neither a cookie nor an error.
    Malformed,
}

pub fn parse(url: &str, scheme: &str) -> Result<Callback, CallbackError> {
    let rest = url.strip_prefix(scheme).and_then(|r| r.strip_prefix("://")).ok_or(CallbackError::NotOurs)?;
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let query = query.split('#').next().unwrap_or("");
    if !matches!(path, "" | "/" | "/sign-in") {
        return Err(CallbackError::NotOurs);
    }
    let params = form_decode(query);
    if let Some(code) = params.get("error") {
        return Ok(Callback::Failed { code: code.clone() });
    }
    match params.get("cookie") {
        Some(cookie) if !cookie.is_empty() => Ok(Callback::SignedIn { set_cookie: cookie.clone() }),
        _ => Err(CallbackError::Malformed),
    }
}

/// `URLSearchParams` decoding, which is how the server wrote the query: `+` is a space. Plain
/// percent-decoding would glue a `+` onto every cookie name after the first in a joined
/// `Set-Cookie` header. The first value of a repeated name wins.
pub fn form_decode(query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let decode = |s: &str| {
            let spaced = s.replace('+', " ");
            percent_decode(&spaced).unwrap_or(spaced)
        };
        params.entry(decode(name)).or_insert_with(|| decode(value));
    }
    params
}

#[cfg(test)]
#[path = "callback_tests.rs"]
mod tests;
