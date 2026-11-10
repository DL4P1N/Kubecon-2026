// The visitor's pixel character: a front-facing voxel-style person, 16 x 24 pixels.
// Stored in localStorage `cc.avatar.v1` as {skin, hair, shirt, pants, hat}: 6-digit hex strings without "#" and a boolean.
// Pure helpers first (unit-tested), then drawAvatar, which only needs a canvas.

export const AVATAR_KEY = "cc.avatar.v1";

export const PALETTE = {
  skin: [
    { hex: "f6d2b0", name: "Light" }, { hex: "e3a979", name: "Fair" }, { hex: "c68642", name: "Tan" },
    { hex: "8d5524", name: "Brown" }, { hex: "5c3a21", name: "Deep" },
  ],
  hair: [
    { hex: "1b1410", name: "Black" }, { hex: "4a2f1b", name: "Brown" }, { hex: "8a5a2b", name: "Chestnut" },
    { hex: "d9b45a", name: "Blond" }, { hex: "a3361f", name: "Red" }, { hex: "b9b9b9", name: "Grey" },
  ],
  shirt: [
    { hex: "c6f19d", name: "Lime" }, { hex: "3b82c4", name: "Blue" }, { hex: "e5604d", name: "Coral" }, { hex: "f2c14e", name: "Yellow" },
    { hex: "2a9d8f", name: "Teal" }, { hex: "f4f7ee", name: "White" }, { hex: "3a3f3a", name: "Graphite" }, { hex: "e8833a", name: "Orange" },
  ],
  pants: [
    { hex: "2f3b52", name: "Navy" }, { hex: "3d3d3d", name: "Charcoal" }, { hex: "6b5a3e", name: "Khaki" }, { hex: "4a6a4a", name: "Olive" },
  ],
};

export const defaultAvatar = () => ({ skin: PALETTE.skin[1].hex, hair: PALETTE.hair[1].hex, shirt: PALETTE.shirt[0].hex, pants: PALETTE.pants[0].hex, hat: false });

const norm = (v) => String(v ?? "").trim().replace(/^#/, "").toLowerCase();

/** Anything that is not a palette value falls back to the default for that part. */
export function sanitizeAvatar(obj) {
  const d = defaultAvatar();
  const o = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  const out = {};
  for (const k of ["skin", "hair", "shirt", "pants"]) {
    const v = norm(o[k]);
    out[k] = PALETTE[k].some((p) => p.hex === v) ? v : d[k];
  }
  out.hat = o.hat === true;
  return out;
}

/** `skin-hair-shirt-pants-h0|h1`, for the app deep link. */
export function avatarParam(a) {
  const s = sanitizeAvatar(a);
  return `${s.skin}-${s.hair}-${s.shirt}-${s.pants}-h${s.hat ? 1 : 0}`;
}

/** The inverse; anything malformed gives the default avatar. */
export function parseAvatarParam(str) {
  const parts = String(str ?? "").split("-");
  if (parts.length !== 5 || !/^h[01]$/.test(parts[4])) return defaultAvatar();
  const [skin, hair, shirt, pants, h] = parts;
  return sanitizeAvatar({ skin, hair, shirt, pants, hat: h === "h1" });
}

/** The look the scene's guide takes: "#"-prefixed colours. */
export function avatarLook(a) {
  const s = sanitizeAvatar(a);
  return { skin: `#${s.skin}`, hair: `#${s.hair}`, shirt: `#${s.shirt}`, pants: `#${s.pants}`, hat: s.hat };
}

export const readAvatar = () => { try { return sanitizeAvatar(JSON.parse(localStorage.getItem(AVATAR_KEY) || "null")); } catch { return defaultAvatar(); } };
export const writeAvatar = (a) => { try { localStorage.setItem(AVATAR_KEY, JSON.stringify(sanitizeAvatar(a))); } catch { /* storage unavailable */ } };

export const AVATAR_W = 16;
export const AVATAR_H = 24;

/** Draws the character at 1 canvas pixel per avatar pixel; size it with CSS (image-rendering: pixelated). */
export function drawAvatar(canvas, avatar) {
  const a = sanitizeAvatar(avatar);
  canvas.width = AVATAR_W;
  canvas.height = AVATAR_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, AVATAR_W, AVATAR_H);
  const px = (hex, x, y, w = 1, h = 1) => { ctx.fillStyle = `#${hex}`; ctx.fillRect(x, y, w, h); };
  const dark = "1b1410";
  px(a.skin, 5, 4, 6, 7);                 // head
  px(a.skin, 7, 11, 2, 1);                // neck
  px(a.hair, 4, 2, 8, 3);                 // hair on top
  px(a.hair, 4, 5, 1, 3); px(a.hair, 11, 5, 1, 3); // sides
  px(dark, 6, 7); px(dark, 9, 7);         // eyes
  px(a.shirt, 4, 12, 8, 6);               // shirt
  px(a.shirt, 2, 12, 2, 3); px(a.shirt, 12, 12, 2, 3); // sleeves
  px(a.skin, 2, 15, 2, 3); px(a.skin, 12, 15, 2, 3);   // hands
  px(a.pants, 4, 18, 8, 3); px(a.pants, 4, 21, 3, 1); px(a.pants, 9, 21, 3, 1); // trousers, legs
  px(dark, 4, 22, 3, 2); px(dark, 9, 22, 3, 2);        // shoes
  if (a.hat) {                            // cap: the shirt colour, with a darker brim
    px(a.shirt, 4, 1, 8, 3);
    px(dark, 3, 4, 10, 1);
  }
}
