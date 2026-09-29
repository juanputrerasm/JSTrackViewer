export class PodFormatError extends Error {
    code;
    /** The directory index of the offending entry, when the error concerns one. */
    entryIndex;
    constructor(code, message, entryIndex = null) {
        super(message);
        this.name = "PodFormatError";
        this.code = code;
        this.entryIndex = entryIndex;
    }
}
