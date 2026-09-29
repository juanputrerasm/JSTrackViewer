/*
  The four stock palettes a texture most often needs and a single archive most often lacks.

  Shared model art in MTM1, MTM2 and CPR is authored against METALCR2.ACT, which ships in
  STARTUP.POD and so is never inside a track or truck POD; the flight games' art is authored
  against their VGA.ACT. A tool handed one archive on its own cannot reach the real file, so
  these copies stand in for it (see paletteCandidates).

  METALCR2 is not one palette: CPR ships a different one from MTM1 and MTM2. Terminal Velocity
  and Fury3 share a VGA.ACT, and Hellbender's differs from theirs.

  Verbatim 768-byte copies of the stock files, base64 encoded:
    metalcr2Mtm1  MTM1 ART/METALCR2.ACT (MTM2 uses the same)
    metalcr2Cpr   CPR ART/METALCR2.ACT
    vgaHB         Hellbender VGA.ACT
    vgaTV         Terminal Velocity / Fury3 VGA.ACT

  Ported from JSPod's and JSTrackViewer's src/shared/bundled-palettes.js and JSTruckViewer's
  src/shared/metalcr2-palette.js, which held the same bytes.
*/
export const BUNDLED_PALETTE_IDS = ["metalcr2Mtm1", "metalcr2Cpr", "vgaHB", "vgaTV"];
const ENCODED = {
    metalcr2Mtm1: "AAAACAgIEBAQGRkZISEhKSkpMTExOjo6QkJCSkpKUlJSWlpaY2Nja2trc3Nze3t7hISEjIyMlJSUnJycpaWlra2ttbW1vb29" +
        "xcXFzs7O1tbW3t7e5ubm7+/v9/f3////BQUFCgkJDg0NExISGBgXHRwaIyEeKCgjLS0mMjMqNzkuOj4xPUQ1QEs4QVA7Q1g/" +
        "SWBFUGpLVXJRWntWYINcZo1ibJZncZ1ueaN2gqp/ibCHkbaPmLyXocKhqciprcytBgYGCwoKEA8PFBMTGRgYHxwcJSEgKiUl" +
        "LykoNS0sOzIwQTY0Rzs4TT46U0M+WkhBYU1Ga1VMdFtRf2NWimtblHJfn3lkp4NsrYt0tJV9u52GwaWOyK6Xzrih1L+p2sez" +
        "DgAAKQUBRAkDXw4EehMFlRgGsBwIyyEJ0j0M2FkQ33QT5ZAW7KwZ8sgd+eMg//8jABQUBh4UDCgUEjIUGDwUHkYVI1AVKVoV" +
        "L2QVNW4VUIYnap45hbdLn89cuudu1P+APz8IT08KXl4Mbm4OfX0Qjo4Snp4Ur68Wv78Yz88a398c7+8e//8g//9N//95//+m" +
        "PwgITwoKXgwMbg4OfRAQjhISnhQUrxYWvxgYzxoa3xwc7x4e/yEh/01N/3p6/6amQgsLUREOYRkQcCERgS0WkTUYoDwZsUIb" +
        "v0we1lMZ71wS+WgY/3cj/5hP/7l6/9qmCAg/CgpPDAxeDg5uEBB9EhKOFBSeFhavGBi/GhrPHBzfHh7vICD/TU3/eXn/pqb/" +
        "Mwg/QwpPUgxeYg5ucRB9ghKOkhSeoxavsxi/wRrPzhzf3B7v6SD/8E3/+Hn+/6b+CD8ICk8KDF4MDm4OEH0QEo4SFJ4UFq8W" +
        "GL8YGs8aHN8cHu8eI/8jT/9Pev96pv+mGFpzIXOEKYyMMZycOaWlQq2tSr21Usa9Ws7GY9bGY9bOc97Oe+fehO/ehPfnnP/3" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    metalcr2Cpr: "AAAAgAAAAIAAgIAAAACAgACAAICAwMDAwNzApsrwAAAADgAABQUFCAgICwoKABQUCAg/KQUBEBAQCgpPAAC/DAxeBh4UGBgX" +
        "GRgYDg5uGRkZQggFMwg/EBB9HRwaDCgUTwoKEhKOISEhIyEeQwpPFBSeUREOXgwKEjIUKiUlFhavKCgjCD8IKSkoUgxeGBi/" +
        "bg4OLS0mGDwUYRkQGhrPNS0sfBAPMTExHBzfMjMqYg5uCk8KOzIwHkYVHh7vcCERNzkujhISICD/Pz8IQTY0cRB9vwAAOjo6" +
        "Oj4xlRgGI1AVDF4MnhQURzs4ghKOQkJCTT46Pkc2gS0WKVoVrxcSDm4OU0M+T08KGFpzkhSeQVA7SkpKvxgYL2QVWkhBkTUY" +
        "vwC/Q1g/zxoaEH0QoxavyyEJUlJSYU1GNW4VXl4MSWBFoDwZ3xwcsxi/Wlpaa1VMEo4SIXOEUGpLsUIb9R8fwRrPTU3/dFtR" +
        "Y2Njbm4O0j0MFJ4UVXJRv0wef2NWa2trUIYnWntWKYyMFq8WAL8AfX0Qimtbc3NzYINc11YTlHJfGL8Ye3t7MZycZo1ijo4S" +
        "n3lk/01Nap45hISEOaWlGs8a9GIVAL+/bplqeXn/33QTp4NsjIyMQq2t70j/np4UHN8crYt0lJSUfaZ6/3cjHu8eSr21tJV9" +
        "nJyc5ZAWhbdLr68Wi7KJ/3p6Usa9u52GI/8jpaWlv78AWs7GwaWOv78Yra2tmLyX+Hn+/5hP7KwZpqb/Y9bKyK6Xn89cocKh" +
        "tbW1z88aqcipzrihc97Ovb29rcytwMDA/6ampMjw8sgd1L+pxcXF/7l6ev96398c/6b+2sezgu3duuduzs7OwNzAhPfn+eMg" +
        "1tbW7+8e3t7e/9qmnP/31P+A5ubm//8g//9N7+/v//95//+m9/f3////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
        "AAAAAAAAAAAAAAAAAAAAAAAA//vwoKCkgICA/wAAAP8A//8AAAD//wD/AP//////",
    vgaHB: "AAAACAgIEBAQGRkZISEhKSkpMTExOjo6QkJCSkpKUlJSWlpaY2Nja2trc3Nze3t7hISEjIyMlJSUnJycpaWlra2ttbW1vb29" +
        "xcXFzs7O1tbW3t7e5ubm7+/v9/f3////AxADBRgFByAHCSgJCzAMDjcQED8TFEUWFksaGlEeHlciIl0oJ2IsK2gxMG03NnM/" +
        "QXtJS4NTVoxdYJRna5xxcaB3eaZ/gayGibKOkbiVmr6dosOkqsmsss+zutW7wtvCBgYGCwoKEA8PFBMTGRgYHxwcJSEgKiUl" +
        "LykoNS0sOzIwQTY0Rzs4TT46U0M+WkhBYU1Ga1VMdFtRf2NWimtblHJfn3lkp4NsrYt0tJV9u52GwaWOyK6Xzrih1L+p2sez" +
        "CAhABwdbBgZ3BQWSAwOtAgLIAQHkAAD/HR3/Ojr/V1f/dHT/kZH/rq7/y8v/6Oj/CEAIB1sHBncGBZIFA60DAsgCAeQBAP8A" +
        "Hf8dOv86V/9XdP90kf+Rrv+uy//L6P/oDgAAKQUBRAkDXw4EehMFlRgGsBwIyyEJ0j0M2FkQ33QT5ZAW7KwZ8sgd+eMg//8j" +
        "WRAGbBMHfhYIkRkIoxwJth4KyCEL2yQL7ScM8EAp8llG9XJj94yA+qWd/L66/9fXNw4EURgGbCQHiDMJokELvFQN1mkP8YEQ" +
        "9Jkr9a5G98Fg+NF7+t2V/Oqx/vTL//3oNQwIQxcLUSIOXy4SbTkVe0QYiFEelV0joWoprnYuu4M0x5A7055C36tK67lR98ZY" +
        "IgUiJgU1KwRILwRbNANuOAOBPQKUQQKnWRCycR69iCzHoDrSuEfd0FXo52Py/3H9ABQUBh4UDCgUEjIUGDwUHkYVI1AVKVoV" +
        "L2QVNW4VUIYnap45hbdLn89cuudu1P+AGFpzIXOEKYyMMZycOaWlQq2tSr21Usa9Ws7GY9bGY9bOc97Oe+fehO/ehPfnnP/3" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    vgaTV: "AAAABwcHDg4OFhYWHR0dJCQkKysrMzMzOjo6QUFBSEhIT09PV1dXXl5eZWVlbGxsdHR0e3t7goKCiYmJkZGRmJiYn5+fpqam" +
        "ra2ttbW1vLy8w8PDysrK0tLS2dnZ4ODgBQUFCgkJDg0NExISGBgXHRwaIyEeKCgjLS0mMjMqNzkuOj4xPUQ1QEs4QVA7Q1g/" +
        "SWBFUGpLVXJRWntWYINcZo1ibJZncZ1ueaN2gqp/ibCHkbaPmLyXocKhqciprcytBgYGCwoKEA8PFBMTGRgYHxwcJSEgKiUl" +
        "LykoNS0sOzIwQTY0Rzs4TT46U0M+WkhBYU1Ga1VMdFtRf2NWimtblHJfn3lkp4NsrYt0tJV9u52GwaWOyK6Xzrih1L+p2sez" +
        "AwMQBQUcCAgnCgozDg08EhFGFxRRHBhbIh1kJyJtLid2NCx/PDKFQjiNSz6VU0mcV02kW1CrYVewa1+0cme2em+6gXe8iYC/" +
        "kIjDl4/Gn5jJp6DNrqfQta/Uu7bXw77bDgAAGwAAKAABNQABQgABTwABXAACaQACdgACgwACkAADnQADqgADtwADxAAExw8H" +
        "yyEJ0DQL1EYN2FkQ3WsS4X4U5ZAW6aMY7rUa8sgd9tof++0h//8j//9s//+2////CAggEBBAGBhgICCAKCigMDDAODjgPz//" +
        "CCAgEEBAGGBgIICAKKCgMMDAOODgP///OA8FRhYHVR8KYikNbzQQfUEUiU4YlVscomghrXYmt4Usw5Yyy6U6zLBJzbpaz8Jp" +
        "AgIlCgUsEgkzGgw6IxBBKxNIMxdPOxpWQx1dSyFkVCRrXChyZCt5bC6AdDKHfDWOhTmUjTyblUCinUOppUawrUq3tk2+vlHF" +
        "xlTMzlfT1lva3l7h52Lo72Xv92n2/2z9Nw4EURgGbCQHiDMJokELvFQN1mkP8YEQ9Jkr9a5G98Fg+NF7+t2V/Oqx/vTL//3o" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const decoded = new Map();
/**
 * A bundled palette's 768 bytes. The same array is returned on every call; copy it before
 * changing it.
 */
export function bundledPalette(id) {
    let bytes = decoded.get(id);
    if (!bytes) {
        bytes = decodeBase64(ENCODED[id]);
        decoded.set(id, bytes);
    }
    return bytes;
}
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Plain base64, without atob or Buffer so the core stays free of host APIs. */
function decodeBase64(text) {
    const clean = text.replace(/=+$/, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let bits = 0;
    let value = 0;
    let o = 0;
    for (let i = 0; i < clean.length; i++) {
        value = (value << 6) | ALPHABET.indexOf(clean[i]);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (value >> bits) & 0xff;
        }
    }
    return out;
}
