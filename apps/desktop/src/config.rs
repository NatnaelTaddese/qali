//! Which Convex deployment the app talks to, and the origin it signs in as.

/// The dev deployment. Set `QALI_DEPLOYMENT=terrific-puffin-582` for prod, once prod trusts
/// `qali://` (the backend's `auth.ts` native-origin change).
const DEFAULT_DEPLOYMENT: &str = "frugal-egret-968";

/// The deep-link scheme the bundle registers. It doubles as the origin the backend's
/// `trustedOrigins` accepts (Better Auth matches non-http origins by prefix).
pub const AUTH_SCHEME: &str = "qali";
pub const AUTH_ORIGIN: &str = "qali://";

/// Keychain service for the session cookies.
pub const KEYCHAIN_SERVICE: &str = "com.myqali.desktop";

#[derive(Clone, Debug)]
pub struct Config {
    pub deployment: String,
}

impl Config {
    pub fn from_env() -> Self {
        let deployment = std::env::var("QALI_DEPLOYMENT")
            .ok()
            .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
            .unwrap_or_else(|| DEFAULT_DEPLOYMENT.to_string());
        Config { deployment }
    }

    pub fn convex_url(&self) -> String {
        format!("https://{}.convex.cloud", self.deployment)
    }

    pub fn site_url(&self) -> String {
        format!("https://{}.convex.site", self.deployment)
    }

    /// Keychain account, per deployment, so dev and prod sessions don't overwrite each other.
    pub fn keychain_account(&self) -> String {
        format!("better-auth-cookies:{}", self.deployment)
    }
}
