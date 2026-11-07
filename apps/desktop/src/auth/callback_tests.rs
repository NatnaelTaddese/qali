use super::*;

#[test]
fn a_signed_in_callback_carries_the_form_decoded_set_cookie() {
    // What `expo()` writes: URLSearchParams turns the spaces in the header into `+`.
    let url = "qali:///?cookie=__Secure-better-auth.session_token%3Dabc%3B+Max-Age%3D604800%2C+__Secure-better-auth.session_data%3Dxyz&ott=123";
    assert_eq!(
        parse(url, "qali"),
        Ok(Callback::SignedIn {
            set_cookie: "__Secure-better-auth.session_token=abc; Max-Age=604800, __Secure-better-auth.session_data=xyz"
                .into()
        })
    );
}

#[test]
fn an_error_callback_reports_its_code() {
    assert_eq!(parse("qali:///sign-in?error=state_mismatch", "qali"), Ok(Callback::Failed { code: "state_mismatch".into() }));
}

#[test]
fn other_schemes_paths_and_empty_links_are_refused() {
    assert_eq!(parse("https://evil.example/?cookie=a%3Db", "qali"), Err(CallbackError::NotOurs));
    assert_eq!(parse("qalix:///?cookie=a%3Db", "qali"), Err(CallbackError::NotOurs));
    assert_eq!(parse("qali://settings/?cookie=a%3Db", "qali"), Err(CallbackError::NotOurs));
    assert_eq!(parse("qali:///", "qali"), Err(CallbackError::Malformed));
    assert_eq!(parse("qali:///?cookie=", "qali"), Err(CallbackError::Malformed));
}

#[test]
fn the_first_of_a_repeated_parameter_wins_and_fragments_are_dropped() {
    assert_eq!(parse("qali:///?cookie=a%3D1&cookie=b%3D2#x", "qali"), Ok(Callback::SignedIn { set_cookie: "a=1".into() }));
}
