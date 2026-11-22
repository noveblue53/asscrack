// L2: text from peers can hold Unicode controls that change the order or the look of the text. Example: the file
// name "report<U+202E>fdp.exe" shows as "reportexe.pdf". These functions remove such characters.

// The bidi controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), U+200B (zero width space) and
// U+FEFF (zero width no-break space). U+200C and U+200D stay: emoji sequences and some scripts need them.
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_RE = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu
// Each Unicode format character (category Cf). A file name does not need one.
const FORMAT_RE = /\p{Cf}/gu

// A display text from a peer (a name, a ready text): no bidi controls and no zero width space.
export function displayText(text) {
    return typeof text === 'string' ? text.replace(HIDDEN_RE, '') : text
}

// A file name from a peer: no format characters.
export function noFormatCharacters(text) {
    return typeof text === 'string' ? text.replace(FORMAT_RE, '') : text
}
