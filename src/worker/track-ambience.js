import { readTxvAmbience } from "../vendor/openphotex/index.js";
import { decodeTrueColorTexture } from "./image-decoder.js";

/*
  A track's own ambience (track format version 6, section 9.6; openmtm2.github.io proposals/track-format-v6.md):
  optional .TXV keys for its sky gradient, sky picture, haze and light tint, which any MTM2 track may carry. Read by
  OpenPhotex readTxvAmbience (colours 0..255, the tint scaled to a mean of 1); the picture (skyImage, a PNG entry) is
  decoded here. `entry` is the track's .TXV entry (DATA\\<level>.TXV, else DATA\\<stem>.TXV). Null when the track
  has none of the keys.
*/
export async function readTrackAmbience(podIndex, getBytes, entry) {
  if (!entry) return null;
  let ambience;
  try { ambience = readTxvAmbience(getBytes(entry)); } catch { return null; }
  if (!ambience) return null;
  let image = null;
  if (ambience.skyImage) {
    const want = ambience.skyImage.replace(/\\/g, "/").toUpperCase();
    const title = want.split("/").pop();
    const imageEntry = podIndex.entries.find((e) => e.normalizedName.toUpperCase() === want)
      ?? podIndex.entries.find((e) => e.title.toUpperCase() === title);
    if (imageEntry) {
      try {
        const decoded = await decodeTrueColorTexture(getBytes(imageEntry), imageEntry.title, imageEntry.title.split(".").pop().toLowerCase());
        image = { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.rgba).buffer };
      } catch { image = null; }
    }
  }
  return {
    skyTop: ambience.skyTop, skyBottom: ambience.skyBottom, skyHorizon: ambience.skyHorizon, skyImage: ambience.skyImage,
    fogColor: ambience.fogColor, fogStartFt: ambience.fogStartFt, fogEndFt: ambience.fogEndFt, lightTint: ambience.lightTint,
    image,
  };
}

