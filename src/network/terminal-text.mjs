// L10: the terminal demo prints peer text. A peer can put ANSI escape sequences or other control characters in a
// name, a message or a file name. This function replaces each C0 control, DEL and each C1 control with '?', so
// that the terminal shows the text and does not obey it.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g

export function terminalText(value) {
    return String(value ?? '').replace(CONTROL_RE, '?')
}
