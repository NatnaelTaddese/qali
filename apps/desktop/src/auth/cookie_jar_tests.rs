use std::time::{Duration, SystemTime};

use super::*;

fn at(secs: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
}

/// The shape Better Auth's `/callback/google` sets: a session token and its cached data,
/// comma-joined, one with an `Expires` date that itself contains a comma.
const SIGNED_IN: &str = "__Secure-better-auth.session_token=abc.def%3D; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=None, \
__Secure-better-auth.session_data=eyJ1Ijo; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/; Secure";

#[test]
fn splits_on_commas_that_start_a_cookie_and_keeps_expires_dates_whole() {
    let parts = split(SIGNED_IN);
    assert_eq!(parts.len(), 2);
    assert!(parts[1].contains("Expires=Wed, 21 Oct 2099"));
}

#[test]
fn parses_names_decoded_values_and_expiry() {
    let cookies = parse(SIGNED_IN);
    assert_eq!(cookies[0].name, "__Secure-better-auth.session_token");
    assert_eq!(cookies[0].value, "abc.def=");
    assert_eq!(cookies[0].max_age, Some(604800));
    assert_eq!(cookies[1].expires, httpdate::parse_http_date("Wed, 21 Oct 2099 07:28:00 GMT").ok());
}

#[test]
fn quoted_values_lose_their_quotes() {
    assert_eq!(parse("a=\"b c\"; Path=/")[0].value, "b c");
}

#[test]
fn merge_tracks_the_session_and_sends_a_sorted_cookie_header() {
    let jar = CookieJar::in_memory();
    assert!(!jar.has_session());
    assert!(jar.merge(SIGNED_IN, at(1_000)));
    assert!(jar.has_session());
    assert_eq!(
        jar.header(at(1_000)).unwrap(),
        "__Secure-better-auth.session_data=eyJ1Ijo; __Secure-better-auth.session_token=abc.def="
    );
    assert!(!jar.merge(SIGNED_IN, at(1_000)), "the same header changes nothing");
}

#[test]
fn expired_cookies_are_not_sent_and_max_age_zero_deletes() {
    let jar = CookieJar::in_memory();
    jar.merge("a=1; Max-Age=10, b=2", at(0));
    assert_eq!(jar.header(at(20)).unwrap(), "b=2");
    jar.merge("b=; Max-Age=0", at(20));
    assert_eq!(jar.header(at(20)), None);
}

#[test]
fn sign_out_clears_the_session_cookie() {
    let jar = CookieJar::in_memory();
    jar.merge(SIGNED_IN, at(0));
    jar.merge("__Secure-better-auth.session_token=; Max-Age=0; Path=/", at(1));
    assert!(!jar.has_session());
}

#[test]
fn percent_decode_rejects_broken_escapes() {
    assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
    assert_eq!(percent_decode("a%2"), None);
    assert_eq!(percent_decode("%ff"), None);
}
