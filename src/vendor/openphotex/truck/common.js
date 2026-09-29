/*
  What every truck and car manifest dialect shares: the line preparation and the vector type.
*/
const decoder = new TextDecoder("latin1");
/*
  The non-empty, trimmed lines of a truck manifest (MTM TRK, Evo TRK, CPR CAR). NUL padding and
  the DOS end-of-file marker (0x1A) both show up in shipped MTM1 manifests and are dropped. Every
  line ending is honoured: CRLF, LF, and a bare CR.
*/
export function truckManifestLines(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    return text
        .replace(/[\u0000\u001a]/g, "")
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
