//! Bounded JSONL framing for the Codex app-server stdio transport.
//!
//! The Codex `app-server --stdio` transport speaks newline-delimited JSON
//! (JSONL): exactly one JSON-RPC object per `\n`-terminated stdout line. A
//! bounded frame is classified as a response, notification, or server request.
//! The parser retains only a method, JSON-RPC id, two non-secret result handles,
//! and a bounded redacted preview. It never retains raw provider payloads.

use serde_json::Value;

/// Maximum accepted length of a single transport line, in bytes.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Maximum length of a retained diagnostic preview, in bytes.
pub const MAX_PREVIEW_BYTES: usize = 256;

/// Classification of a framed line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameClass {
    /// Server response to a client request (`id` + `result`/`error`).
    Response { ok: bool },
    /// Server-initiated notification / event (`method`, no `id`).
    Notification,
    /// Server-initiated request expecting a reply (`method` + `id`).
    ServerRequest,
}

/// A successfully classified frame. Holds only what the neutral contract needs
/// plus a bounded redacted preview — never the raw structured payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub class: FrameClass,
    /// Wire method name, if present. It is mapped before crossing the neutral
    /// Session contract boundary.
    pub method: Option<String>,
    /// Raw top-level JSON-RPC id token (number or quoted string), if present.
    pub id: Option<String>,
    /// For a successful response, the `result.thread.id` string, if present.
    pub result_thread_id: Option<String>,
    /// For a successful response, the `result.turn.id` string, if present.
    pub result_turn_id: Option<String>,
    /// Whether this frame carries a structured top-level `params` member.
    pub has_params: bool,
    /// For a turn notification, the `params.turn.id` string, if present.
    pub event_turn_id: Option<String>,
    /// Bounded, secret-redacted diagnostic preview of the line.
    pub preview: String,
}

/// Field selector for [`Frame::result_field`].
#[derive(Debug, Clone, Copy)]
pub enum ResultField {
    ThreadId,
    TurnId,
}

impl Frame {
    /// The pre-extracted result id for `field`, if this frame carried it.
    pub fn result_field(&self, field: ResultField) -> Option<String> {
        match field {
            ResultField::ThreadId => self.result_thread_id.clone(),
            ResultField::TurnId => self.result_turn_id.clone(),
        }
    }
}

/// Typed scan failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanError {
    /// Line exceeded [`MAX_LINE_BYTES`].
    OverLimit { len: usize },
    /// Line was not a well-formed top-level JSON object we can classify.
    Malformed,
    /// Empty / whitespace-only line.
    Empty,
}

impl ScanError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::OverLimit { .. } => "over_limit",
            Self::Malformed => "malformed",
            Self::Empty => "empty",
        }
    }
}

/// Scan and classify one bounded JSONL frame.
pub fn scan_line(line: &[u8]) -> Result<Frame, ScanError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(ScanError::OverLimit { len: line.len() });
    }
    let trimmed = trim_ascii_ws(line);
    if trimmed.is_empty() {
        return Err(ScanError::Empty);
    }

    // Deserialize only after enforcing the transport bound. This fully rejects
    // malformed JSON and trailing garbage; `value` is dropped at function exit.
    let value: Value = serde_json::from_slice(trimmed).map_err(|_| ScanError::Malformed)?;
    let object = value.as_object().ok_or(ScanError::Malformed)?;
    let method = match object.get("method") {
        None => None,
        Some(Value::String(method)) => Some(method.clone()),
        Some(_) => return Err(ScanError::Malformed),
    };
    let id = match object.get("id") {
        None => None,
        Some(Value::String(id)) => {
            Some(serde_json::to_string(id).map_err(|_| ScanError::Malformed)?)
        }
        Some(Value::Number(id)) if id.is_i64() || id.is_u64() => {
            Some(serde_json::to_string(id).map_err(|_| ScanError::Malformed)?)
        }
        Some(_) => return Err(ScanError::Malformed),
    };
    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    let params = object.get("params");
    let has_params = params.is_some();
    let params_are_structured = params.is_none_or(|params| params.is_object() || params.is_array());
    let json_rpc_2 =
        matches!(object.get("jsonrpc"), Some(Value::String(version)) if version == "2.0");
    let class = match (&method, &id) {
        (Some(_), Some(_)) if json_rpc_2 && !has_result && !has_error && params_are_structured => {
            FrameClass::ServerRequest
        }
        (Some(_), None) if !has_result && !has_error => FrameClass::Notification,
        (None, Some(_)) if json_rpc_2 && (has_result != has_error) => {
            FrameClass::Response { ok: has_result }
        }
        _ => return Err(ScanError::Malformed),
    };

    let (result_thread_id, result_turn_id) = if matches!(class, FrameClass::Response { ok: true }) {
        let result = object.get("result");
        (
            nested_result_id(result, "thread"),
            nested_result_id(result, "turn"),
        )
    } else {
        (None, None)
    };

    let event_turn_id = if matches!(class, FrameClass::Notification) {
        nested_result_id(params, "turn")
    } else {
        None
    };

    Ok(Frame {
        class,
        method,
        id,
        result_thread_id,
        result_turn_id,
        has_params,
        event_turn_id,
        preview: redacted_preview(trimmed),
    })
}

/// Extract `result.<outer>.id` without retaining the result object.
fn nested_result_id(result: Option<&Value>, outer: &str) -> Option<String> {
    result?
        .as_object()?
        .get(outer)?
        .as_object()?
        .get("id")?
        .as_str()
        .map(str::to_owned)
}

/// Redact obvious secrets, then bound the string to [`MAX_PREVIEW_BYTES`].
pub fn redacted_preview(line: &[u8]) -> String {
    let mut text = redact_secrets(&String::from_utf8_lossy(line));
    if text.len() > MAX_PREVIEW_BYTES {
        let mut end = MAX_PREVIEW_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("…[truncated]");
    }
    text
}

/// Mask secret-looking JSON values, bare Bearer values, and `sk-` tokens.
pub fn redact_secrets(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            if let Some(key_end) = string_end(bytes, i) {
                let after_key = skip_ws(bytes, key_end);
                let value_start = skip_ws(bytes, after_key.saturating_add(1));
                if after_key < bytes.len()
                    && bytes[after_key] == b':'
                    && value_start < bytes.len()
                    && bytes[value_start] == b'"'
                    && is_secret_json_key(&bytes[i + 1..key_end - 1])
                    && let Some(value_end) = string_end(bytes, value_start)
                {
                    output.push_str(&input[i..value_start]);
                    output.push_str("\"[redacted]\"");
                    i = value_end;
                    continue;
                }

                output.push('"');
                append_redacted_tokens(input, i + 1, key_end - 1, &mut output);
                output.push('"');
                i = key_end;
                continue;
            }
        }
        let end = bytes[i..]
            .iter()
            .position(|byte| *byte == b'"')
            .map_or(bytes.len(), |offset| i + offset);
        if end == i {
            output.push('"');
            i += 1;
        } else {
            append_redacted_tokens(input, i, end, &mut output);
            i = end;
        }
    }
    output
}

/// Recognize secret JSON keys after decoding ASCII JSON escapes, folding ASCII
/// case, and removing underscores. This keeps snake_case and camelCase forms
/// equivalent without broadening matching beyond the known credential fields.
fn is_secret_json_key(bytes: &[u8]) -> bool {
    const SECRET_KEYS: &[&[u8]] = &[
        b"token",
        b"secret",
        b"password",
        b"authorization",
        b"apikey",
        b"bearer",
        b"accesstoken",
        b"refreshtoken",
        b"idtoken",
        b"clientsecret",
    ];

    let mut canonical = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let byte = if bytes[i] == b'\\' {
            let Some(&escape) = bytes.get(i + 1) else {
                return false;
            };
            match escape {
                b'"' | b'\\' | b'/' => {
                    i += 2;
                    escape
                }
                b'b' => {
                    i += 2;
                    b'\x08'
                }
                b'f' => {
                    i += 2;
                    b'\x0c'
                }
                b'n' => {
                    i += 2;
                    b'\n'
                }
                b'r' => {
                    i += 2;
                    b'\r'
                }
                b't' => {
                    i += 2;
                    b'\t'
                }
                b'u' => {
                    let Some(escape_bytes) = bytes.get(i + 2..i + 6) else {
                        return false;
                    };
                    let Some(byte) = decode_ascii_unicode_escape(escape_bytes) else {
                        return false;
                    };
                    i += 6;
                    byte
                }
                _ => return false,
            }
        } else {
            let byte = bytes[i];
            i += 1;
            byte
        };

        if byte != b'_' {
            canonical.push(byte.to_ascii_lowercase());
        }
    }

    SECRET_KEYS.contains(&canonical.as_slice())
}

fn decode_ascii_unicode_escape(bytes: &[u8]) -> Option<u8> {
    let codepoint = bytes.iter().try_fold(0_u16, |value, byte| {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return None,
        };
        Some(value * 16 + u16::from(digit))
    })?;
    u8::try_from(codepoint).ok()
}

fn append_redacted_tokens(input: &str, mut i: usize, end: usize, output: &mut String) {
    let bytes = input.as_bytes();
    while i < end {
        if starts_with_ci(&bytes[i..end], b"bearer ") {
            output.push_str("Bearer [redacted]");
            i += 7;
            while i < end && !bytes[i].is_ascii_whitespace() && bytes[i] != b'"' {
                i += 1;
            }
            continue;
        }
        if starts_with_ci(&bytes[i..end], b"sk-") && is_token_boundary(bytes, i) {
            output.push_str("sk-[redacted]");
            i += 3;
            while i < end && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'-' | b'_')) {
                i += 1;
            }
            continue;
        }
        let character_end = (i + utf8_len(bytes[i])).min(end);
        output.push_str(&input[i..character_end]);
        i = character_end;
    }
}

fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn trim_ascii_ws(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    let mut end = bytes.len();
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    &bytes[start..end]
}

fn starts_with_ci(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.len() >= needle.len()
        && haystack[..needle.len()]
            .iter()
            .zip(needle)
            .all(|(actual, expected)| actual.eq_ignore_ascii_case(expected))
}

fn is_token_boundary(bytes: &[u8], index: usize) -> bool {
    index == 0
        || !matches!(bytes[index - 1], byte if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

const fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn classifies_notification_response_and_server_request() {
        let notification =
            scan_line(br#"{"jsonrpc":"2.0","method":"thread/started","params":{"a":1}}"#).unwrap();
        assert_eq!(notification.class, FrameClass::Notification);
        assert_eq!(notification.method.as_deref(), Some("thread/started"));

        let response =
            scan_line(br#"{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"x"}}}"#).unwrap();
        assert_eq!(response.class, FrameClass::Response { ok: true });
        assert_eq!(response.id.as_deref(), Some("2"));
        assert_eq!(response.result_thread_id.as_deref(), Some("x"));

        let request =
            scan_line(br#"{"jsonrpc":"2.0","id":"abc","method":"openai/form","params":{}}"#)
                .unwrap();
        assert_eq!(request.class, FrameClass::ServerRequest);
        assert_eq!(request.id.as_deref(), Some("\"abc\""));
    }

    #[test]
    fn nested_values_and_escaped_strings_are_valid_json() {
        let frame = scan_line(br#"{"method":"item/completed","params":{"text":"a } { \" nested","obj":{"k":[1,2,{"z":"}"}]}}}"#).unwrap();
        assert_eq!(frame.class, FrameClass::Notification);
        assert_eq!(frame.method.as_deref(), Some("item/completed"));
    }

    #[test]
    fn escaped_quotes_in_non_secret_notifications_scale_linearly() {
        fn notification(escaped_quotes: usize) -> Vec<u8> {
            let mut line = b"{\"method\":\"item/completed\",\"params\":{\"note\":\"".to_vec();
            for _ in 0..escaped_quotes {
                line.push(b'\\');
                line.push(b'\"');
            }
            line.extend_from_slice(b"\"}}");
            line
        }

        let small = notification(15_000);
        let large = notification(30_000);
        assert!(large.len() < MAX_LINE_BYTES);

        let started = Instant::now();
        let small_frame = scan_line(&small).unwrap();
        let small_elapsed = started.elapsed();
        assert_eq!(small_frame.class, FrameClass::Notification);

        let started = Instant::now();
        let large_frame = scan_line(&large).unwrap();
        let large_elapsed = started.elapsed();
        assert_eq!(large_frame.class, FrameClass::Notification);

        assert!(
            large_elapsed <= small_elapsed.saturating_mul(3) + Duration::from_millis(50),
            "expected linear scaling, got {small_elapsed:?} for {} bytes and {large_elapsed:?} for {} bytes",
            small.len(),
            large.len(),
        );
    }

    #[test]
    fn malformed_empty_trailing_and_invalid_ids_are_typed() {
        assert_eq!(scan_line(b"not json"), Err(ScanError::Malformed));
        assert_eq!(scan_line(b"   "), Err(ScanError::Empty));
        assert_eq!(scan_line(br#"{"method":"x""#), Err(ScanError::Malformed));
        assert_eq!(
            scan_line(br#"{"id":1,"result":{}} trailing"#),
            Err(ScanError::Malformed)
        );
        assert_eq!(
            scan_line(br#"{"id":{},"result":{}}"#),
            Err(ScanError::Malformed)
        );
    }

    #[test]
    fn unsupported_json_rpc_request_and_response_shapes_are_rejected() {
        let invalid: &[&[u8]] = &[
            br#"{"id":1,"result":{}}"#,
            br#"{"jsonrpc":"2.0","id":1.5,"result":{}}"#,
            br#"{"jsonrpc":"2.0","id":1,"result":{},"error":{}}"#,
            br#"{"jsonrpc":"2.0","id":1.5,"method":"item/fileChange/requestApproval","params":{}}"#,
            br#"{"jsonrpc":"2.0","id":1,"method":"item/fileChange/requestApproval","params":"not-structured"}"#,
        ];

        for line in invalid {
            assert_eq!(scan_line(line), Err(ScanError::Malformed));
        }
    }

    #[test]
    fn over_limit_line_is_rejected_before_parsing() {
        let mut line = Vec::from(&b"{\"method\":\""[..]);
        line.extend(std::iter::repeat_n(b'a', MAX_LINE_BYTES + 10));
        line.extend_from_slice(b"\"}");
        assert!(matches!(scan_line(&line), Err(ScanError::OverLimit { .. })));
    }

    #[test]
    fn secret_values_bearers_and_sk_tokens_are_masked() {
        let frame =
            scan_line(br#"{"method":"auth","params":{"access_token":"sk-DEADBEEF","note":"ok"}}"#)
                .unwrap();
        assert!(!frame.preview.contains("DEADBEEF"));
        assert!(frame.preview.contains("[redacted]"));
        assert!(frame.preview.contains("\"note\":\"ok\""));

        let preview = redact_secrets("Authorization: Bearer abc.def.ghi and key sk-XYZ123");
        assert!(!preview.contains("abc.def.ghi"));
        assert!(!preview.contains("XYZ123"));
        assert!(preview.contains("Bearer [redacted]"));
        assert!(preview.contains("sk-[redacted]"));
    }

    #[test]
    fn frame_preview_masks_camel_case_credential_keys_and_escaped_forms() {
        let frame = scan_line(
            br#"{"method":"auth","params":{"accessToken":"mask-me-a","refreshToken":"mask-me-b","idToken":"mask-me-c","client\u0053ecret":"mask-me-\u0064"}}"#,
        )
        .unwrap();

        assert_eq!(frame.preview.matches("\"[redacted]\"").count(), 4);
        assert!(!frame.preview.contains("mask-me"));
        assert!(serde_json::from_str::<Value>(&frame.preview).is_ok());
    }

    #[test]
    fn preview_is_bounded() {
        let mut line = Vec::from(&b"{\"method\":\"x\",\"params\":\""[..]);
        line.extend(std::iter::repeat_n(b'z', MAX_PREVIEW_BYTES * 4));
        line.extend_from_slice(b"\"}");
        let preview = redacted_preview(&line);
        assert!(preview.len() <= MAX_PREVIEW_BYTES + "…[truncated]".len());
        assert!(preview.ends_with("…[truncated]"));
    }
}
