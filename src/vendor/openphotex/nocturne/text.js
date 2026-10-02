export function nocturneLines(bytes) {
    return new TextDecoder("latin1").decode(bytes).replace(/^[\x00\x1a]+|[\x00\x1a]+$/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
export function nocturneDataLines(bytes) {
    return nocturneLines(bytes).filter((line) => !line.startsWith("//"));
}
export function csv(line) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"')
            quoted = !quoted;
        else if (c === "," && !quoted) {
            fields.push(field.trim());
            field = "";
        }
        else
            field += c;
    }
    fields.push(field.trim());
    return fields;
}
export function numbers(line) {
    return csv(line).map((field) => {
        const value = Number(field);
        if (!Number.isFinite(value))
            throw new Error(`Expected a number, got '${field}'.`);
        return value;
    });
}
export function integer(line, what) {
    const value = Number(line);
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`Invalid ${what}: '${line}'.`);
    return value;
}
export function unquote(value) {
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
export class LineReader {
    index = 0;
    lines;
    name;
    constructor(lines, name) { this.lines = lines; this.name = name; }
    next(what) {
        if (this.index >= this.lines.length)
            throw new Error(`${this.name}: missing ${what}.`);
        return this.lines[this.index++];
    }
    nums(what, count) {
        const result = numbers(this.next(what));
        if (count !== undefined && result.length !== count)
            throw new Error(`${this.name}: ${what} has ${result.length} values, expected ${count}.`);
        return result;
    }
    count(what) { return integer(this.next(what), what); }
    done() {
        if (this.index !== this.lines.length)
            throw new Error(`${this.name}: ${this.lines.length - this.index} trailing data lines.`);
    }
}
