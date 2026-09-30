/*
  Fly!'s tagged text, shared by the scenery manifests (.SCF), the object placement files
  (SCENERY.Sxx) and the sectional chart descriptions (.MAP). See docs/FLY.md.

    <name> ---- scenery set name ----
    San Francisco
    <file>
    sanfran1.epd
    <mmgr>
    <bgno>
      <modl>
      comp
      BLUTANK.BIN
    <endo>

  A tag is four characters in angle brackets at the start of a line; anything after it on the
  same line is a comment. The lines up to the next tag are its values. `<bgno>` opens a block
  and `<endo>` closes it, and a block belongs to the tag before it (a tag can own several, as
  a chart's <grid> owns one per grid entry). A file is itself one block with no tag in front,
  so the reader returns that block's contents.

  Verified on every stock .SCF, .MAP and SCENERY.Sxx: 1580 objects in 24 placement files,
  every block closed.
*/
const TAG_LINE = /^<(.{4})>/;
const decoder = new TextDecoder("latin1");
/** Reads Fly! tagged text into its tags, unwrapping the block the whole file sits in. */
export function parseFlyTagged(input, sourceName = "tagged text") {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const top = [];
    // The lists of the open blocks, innermost last.
    const stack = [top];
    for (const raw of text.split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        if (!line)
            continue;
        const list = stack[stack.length - 1];
        const match = TAG_LINE.exec(line);
        if (!match) {
            list[list.length - 1]?.values.push(line);
            continue;
        }
        const tag = match[1].trimEnd();
        if (tag === "bgno") {
            // A block belongs to the tag before it; one with nothing in front gets an anonymous owner.
            let owner = list[list.length - 1];
            if (!owner) {
                owner = { tag: "", values: [], blocks: [] };
                list.push(owner);
            }
            const block = [];
            owner.blocks.push(block);
            stack.push(block);
        }
        else if (tag === "endo") {
            if (stack.length === 1)
                throw new Error(`${sourceName}: <endo> without a matching <bgno>`);
            stack.pop();
        }
        else {
            list.push({ tag, values: [], blocks: [] });
        }
    }
    // The whole file is normally one anonymous block: return what is inside it.
    if (top.length === 1 && top[0].tag === "" && top[0].blocks.length === 1)
        return top[0].blocks[0];
    return top;
}
/** The first tag named `tag`, or null. */
export function flyTag(tags, tag) {
    return tags.find((t) => t.tag === tag) ?? null;
}
/** Every tag named `tag`, in file order. */
export function flyTags(tags, tag) {
    return tags.filter((t) => t.tag === tag);
}
/*
  A latitude or longitude as Fly! writes it, in any of its three spellings:

    36 43 17.33 N          .SCF: degrees, minutes, seconds, hemisphere
    37 54'43.8401"N        SCENERY.Sxx
    34 17'N                .MAP: degrees and minutes only

  Returns signed decimal degrees (south and west negative), or null for anything else.
*/
const ANGLE = /^(\d+)\s+(\d+(?:\.\d+)?)\s*'?\s*(?:(\d+(?:\.\d+)?)\s*"?)?\s*([NSEW])$/i;
export function parseFlyAngle(text) {
    const match = ANGLE.exec(text.trim());
    if (!match)
        return null;
    const degrees = Number(match[1]) + Number(match[2]) / 60 + Number(match[3] ?? 0) / 3600;
    const hemisphere = match[4].toUpperCase();
    return hemisphere === "S" || hemisphere === "W" ? -degrees : degrees;
}
