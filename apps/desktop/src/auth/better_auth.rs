//! Talks to Better Auth on the Convex site origin the way `@better-auth/expo`'s client does
//! (a port of the iOS app's `BetterAuthClient.swift`). Every request carries the stored
//! cookies plus `expo-origin: qali://`, which the backend's `expo()` plugin promotes to
//! `Origin` so `trustedOrigins` accepts it. OAuth runs in the user's browser through the
//! plugin's `/expo-authorization-proxy`, and the session comes back on the
//! `qali:///?cookie=<Set-Cookie>` link that macOS hands the app.

use std::time::SystemTime;

use anyhow::{Context, Result, anyhow, bail};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::callback::{self, Callback, CallbackError};
use super::cookie_jar::CookieJar;
use crate::config::{AUTH_ORIGIN, AUTH_SCHEME};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionUser {
    pub id: String,
    pub name: String,
    pub email: String,
    pub image: Option<String>,
}

#[derive(Debug)]
pub enum AuthError {
    NotSignedIn,
    Callback(String),
    Server(StatusCode, Option<String>),
}

impl std::error::Error for AuthError {}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::NotSignedIn => write!(f, "You're not signed in."),
            AuthError::Callback(code) => write!(f, "Sign-in failed ({code})."),
            AuthError::Server(status, Some(message)) => write!(f, "{message} ({status})"),
            AuthError::Server(status, None) => write!(f, "The server returned {status}."),
        }
    }
}

pub struct BetterAuth {
    base: String,
    http: reqwest::Client,
    pub jar: CookieJar,
}

impl BetterAuth {
    pub fn new(site_url: &str, jar: CookieJar) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("qali-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("an HTTP client");
        BetterAuth { base: format!("{site_url}/api/auth"), http, jar }
    }

    /// Starts Google OAuth and returns the URL to open in the browser. A new sign-in replaces
    /// whatever session was stored before.
    pub async fn start_google(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Response {
            url: String,
        }
        self.jar.clear();
        let body = json!({
            "provider": "google",
            // What Expo's `Linking.createURL("/")` produces for a standalone build.
            "callbackURL": format!("{AUTH_ORIGIN}/"),
            "errorCallbackURL": format!("{AUTH_ORIGIN}/sign-in"),
        });
        let response: Response = self.send(Method::POST, "sign-in/social", Some(body)).await?;
        // The proxy re-sets the OAuth state cookie inside the browser, so Google's redirect
        // back to /callback/google carries it. Without `oauthState` it signs the URL's own
        // `state` instead, which is what a fresh sign-in needs.
        let mut proxy = url::Url::parse(&format!("{}/expo-authorization-proxy", self.base))?;
        proxy.query_pairs_mut().append_pair("authorizationURL", &response.url);
        if let Some(state) =
            self.jar.value("__Secure-better-auth.oauth_state").or_else(|| self.jar.value("better-auth.oauth_state"))
        {
            proxy.query_pairs_mut().append_pair("oauthState", &state);
        }
        Ok(proxy.into())
    }

    /// Finishes sign-in from the callback link. `Ok(false)` means the link wasn't ours.
    pub fn complete(&self, link: &str) -> Result<bool> {
        match callback::parse(link, AUTH_SCHEME) {
            Ok(Callback::SignedIn { set_cookie }) => {
                self.jar.merge(&set_cookie, SystemTime::now());
                if !self.jar.has_session() {
                    bail!(AuthError::NotSignedIn);
                }
                Ok(true)
            }
            Ok(Callback::Failed { code }) => Err(AuthError::Callback(code).into()),
            Err(CallbackError::NotOurs) => Ok(false),
            Err(CallbackError::Malformed) => Err(anyhow!("The sign-in link was incomplete.")),
        }
    }

    /// A fresh Convex JWT for the stored session (the `convex()` plugin's `/convex/token`).
    pub async fn convex_token(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Response {
            token: String,
        }
        if !self.jar.has_session() {
            bail!(AuthError::NotSignedIn);
        }
        match self.send::<Response>(Method::GET, "convex/token", None).await {
            Ok(r) => Ok(r.token),
            Err(e) => match e.downcast_ref::<AuthError>() {
                Some(AuthError::Server(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN, _)) => {
                    Err(AuthError::NotSignedIn.into())
                }
                _ => Err(e),
            },
        }
    }

    /// The signed-in user, or `None` when the stored session is gone or expired.
    pub async fn current_user(&self) -> Result<Option<SessionUser>> {
        #[derive(Deserialize)]
        struct Response {
            user: SessionUser,
        }
        if !self.jar.has_session() {
            return Ok(None);
        }
        let response: Option<Response> = self.send(Method::GET, "get-session", None).await?;
        Ok(response.map(|r| r.user))
    }

    /// Revokes the session server-side (best effort) and forgets it locally.
    pub async fn sign_out(&self) {
        let _ = self.send::<Value>(Method::POST, "sign-out", Some(json!({}))).await;
        self.jar.clear();
    }

    async fn send<T: DeserializeOwned>(&self, method: Method, path: &str, body: Option<Value>) -> Result<T> {
        let mut request = self
            .http
            .request(method, format!("{}/{path}", self.base))
            .header("expo-origin", AUTH_ORIGIN)
            .header("x-skip-oauth-proxy", "true")
            .header("accept", "application/json");
        if let Some(cookie) = self.jar.header(SystemTime::now()) {
            request = request.header("cookie", cookie);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.context("Couldn't reach Qali")?;
        let status = response.status();
        let set_cookies: Vec<String> = response
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok().map(str::to_string))
            .collect();
        if !set_cookies.is_empty() {
            self.jar.merge(&set_cookies.join(", "), SystemTime::now());
        }
        let bytes = response.bytes().await?;
        if !status.is_success() {
            #[derive(Deserialize)]
            struct ErrorBody {
                message: Option<String>,
            }
            let message = serde_json::from_slice::<ErrorBody>(&bytes).ok().and_then(|b| b.message);
            bail!(AuthError::Server(status, message));
        }
        serde_json::from_slice(&bytes).context("The server sent an unexpected response")
    }
}
