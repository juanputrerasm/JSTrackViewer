import { splitEvoLines } from "./text.js";
/** Splits `text` on `separator` where it is outside quotes and brackets. */
function splitOutside(text, separator) {
    const parts = [];
    let depth = 0, quoted = false, start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"')
            quoted = !quoted;
        else if (!quoted && ch === "(")
            depth++;
        else if (!quoted && ch === ")")
            depth--;
        else if (!quoted && depth === 0) {
            separator.lastIndex = i;
            const m = separator.exec(text);
            if (m && m.index === i) {
                parts.push(text.slice(start, i));
                i += m[0].length - 1;
                start = i + 1;
            }
        }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}
function parseCall(text) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/s.exec(text.trim());
    if (!m)
        return null;
    const args = m[2].trim() ? splitOutside(m[2], /,/y).map((a) => (a.startsWith('"') && a.endsWith('"') && a.length >= 2 ? a.slice(1, -1) : a)) : [];
    return { name: m[1], args };
}
/** Removes a `//` comment that is not inside quotes. */
function stripComment(line) {
    let quoted = false;
    for (let i = 0; i < line.length - 1; i++) {
        if (line[i] === '"')
            quoted = !quoted;
        else if (!quoted && line[i] === "/" && line[i + 1] === "/")
            return line.slice(0, i);
    }
    return line;
}
export function parseEvoScript(bytes, sourceName) {
    const rules = [];
    const warnings = [];
    splitEvoLines(bytes).forEach((raw, index) => {
        const text = stripComment(raw).trim();
        if (!text)
            return;
        const arrow = text.indexOf("->");
        const left = arrow >= 0 ? text.slice(0, arrow) : "";
        const right = arrow >= 0 ? text.slice(arrow + 2) : text;
        const conditions = [];
        for (const part of splitOutside(left, /&&|&/y)) {
            const negate = part.startsWith("!");
            const body = negate ? part.slice(1).trim() : part;
            const call = parseCall(body);
            if (call)
                conditions.push({ negate, call, flag: null });
            else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(body))
                conditions.push({ negate, call: null, flag: body });
            else
                warnings.push(`${sourceName}:${index + 1}: unreadable condition "${part}"`);
        }
        const actions = [];
        for (const part of splitOutside(right, /;/y)) {
            const call = parseCall(part);
            if (call)
                actions.push(call);
            else
                warnings.push(`${sourceName}:${index + 1}: unreadable action "${part}"`);
        }
        if (actions.length)
            rules.push({ conditions, actions, line: index + 1 });
    });
    return { sourceName, rules, warnings };
}
