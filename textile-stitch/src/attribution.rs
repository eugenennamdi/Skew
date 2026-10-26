// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Textile, Inc. / Skew Project
//! ERC-8021 Transaction Calldata Suffix for Hackathon Attribution.

pub const ATTRIBUTION_TAG: &str = "celo_7935fb97e273";
pub const SCHEMA_ID: u8 = 0x00;

pub const ERC_MARKER: [u8; 16] = [
    0x80, 0x21, 0x80, 0x21, 0x80, 0x21, 0x80, 0x21,
    0x80, 0x21, 0x80, 0x21, 0x80, 0x21, 0x80, 0x21,
];

/// Generates the static 35-byte ERC-8021 attribution suffix:
/// [17 bytes: "celo_7935fb97e273"] + [1 byte: 0x11] + [1 byte: 0x00] + [16 bytes: ERC_MARKER]
pub fn suffix() -> Vec<u8> {
    let tag_bytes = ATTRIBUTION_TAG.as_bytes();
    let mut out = Vec::with_capacity(tag_bytes.len() + 2 + ERC_MARKER.len());
    out.extend_from_slice(tag_bytes);
    out.push(tag_bytes.len() as u8); // 17 (0x11)
    out.push(SCHEMA_ID);             // 0 (0x00)
    out.extend_from_slice(&ERC_MARKER);
    out
}

/// Appends the ERC-8021 attribution suffix to raw transaction calldata.
pub fn append_attribution(calldata: &[u8]) -> Vec<u8> {
    let mut tagged = Vec::with_capacity(calldata.len() + 35);
    tagged.extend_from_slice(calldata);
    tagged.extend_from_slice(&suffix());
    tagged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_attribution_suffix_format() {
        let s = suffix();
        assert_eq!(s.len(), 35);
        assert_eq!(&s[..17], ATTRIBUTION_TAG.as_bytes());
        assert_eq!(s[17], 17);
        assert_eq!(s[18], 0);
        assert_eq!(&s[19..], &ERC_MARKER);

        // Dummy ERC-20 approve() calldata (68 bytes)
        let dummy_approve = vec![0x09, 0x5e, 0xa7, 0xb3];
        let tagged = append_attribution(&dummy_approve);
        assert_eq!(tagged.len(), dummy_approve.len() + 35);
        assert_eq!(&tagged[..4], &dummy_approve);
        assert_eq!(&tagged[4..], &s);
    }
}
