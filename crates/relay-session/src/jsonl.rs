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
        None | Some(Value::Null) => None,
        Some(id @ (Value::String(_) | Value::Number(_))) => {
            Some(serde_json::to_string(id).map_err(|_| ScanError::Malformed)?)
        }
        Some(_) => return Err(ScanError::Malformed),
    };
    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    let class = match (&method, &id) {
        (Some(_), Some(_)) => FrameClass::ServerRequest,
        (Some(_), None) => FrameClass::Notification,
        (None, Some(_)) if has_result || has_error => FrameClass::Response { ok: has_result },
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

    Ok(Frame {
        class,
        method,
        id,
        result_thread_id,
        result_turn_id,
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
    const SECRET_KEYS: &[&str] = &[
        "token",
        "secret",
        "password",
        "authorization",
        "apikey",
        "api_key",
        "bearer",
        "access_token",
        "refresh_token",
        "id_token",
        "client_secret",
    ];

    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            if let Some((key_end, key)) = read_json_key(bytes, i) {
                let after_key = skip_ws(bytes, key_end);
                let value_start = skip_ws(bytes, after_key.saturating_add(1));
                if after_key < bytes.len()
                    && bytes[after_key] == b':'
                    && value_start < bytes.len()
                    && bytes[value_start] == b'"'
                    && SECRET_KEYS.contains(&key.to_ascii_lowercase().as_str())
                    && let Some(value_end) = string_end(bytes, value_start)
                {
                    output.push('"');
                    output.push_str(&key);
                    output.push('"');
                    output.push_str(&input[key_end..after_key + 1]);
                    output.push_str("\"[redacted]\"");
                    i = value_end;
                    continue;
                }
            }
        }
        if starts_with_ci(&bytes[i..], b"bearer ") {
            output.push_str("Bearer [redacted]");
            i += 7;
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'"' {
                i += 1;
            }
            continue;
        }
        if starts_with_ci(&bytes[i..], b"sk-") && is_token_boundary(bytes, i) {
            output.push_str("sk-[redacted]");
            i += 3;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'-' | b'_'))
            {
                i += 1;
            }
            continue;
        }
        let end = (i + utf8_len(bytes[i])).min(bytes.len());
        output.push_str(&input[i..end]);
        i = end;
    }
    output
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

fn read_json_key(bytes: &[u8], start: usize) -> Option<(usize, String)> {
    let end = string_end(bytes, start)?;
    Some((end, unescape_ascii(&bytes[start + 1..end - 1])))
}

fn unescape_ascii(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'n' => output.push('\n'),
                b't' => output.push('\t'),
                b'r' => output.push('\r'),
                b'"' => output.push('"'),
                b'\\' => output.push('\\'),
                b'/' => output.push('/'),
                other => {
                    output.push('\\');
                    output.push(other as char);
                }
            }
            i += 2;
        } else {
            let end = (i + utf8_len(bytes[i])).min(bytes.len());
            output.push_str(&String::from_utf8_lossy(&bytes[i..end]));
            i = end;
        }
    }
    output
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
    fn preview_is_bounded() {
        let mut line = Vec::from(&b"{\"method\":\"x\",\"params\":\""[..]);
        line.extend(std::iter::repeat_n(b'z', MAX_PREVIEW_BYTES * 4));
        line.extend_from_slice(b"\"}");
        let preview = redacted_preview(&line);
        assert!(preview.len() <= MAX_PREVIEW_BYTES + "…[truncated]".len());
        assert!(preview.ends_with("…[truncated]"));
    }
}
