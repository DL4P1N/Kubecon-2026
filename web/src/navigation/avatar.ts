/** Pixel people: the avatar shape, strict validation of the stored look, and the sprite as a list of rectangles. */

export interface Avatar { skin: string; hair: string; shirt: string; pants: string; hat: boolean }
export const AVATAR_KEY = "cc.avatar.v1";
export const DEFAULT_AVATAR: Avatar = { skin: "f1c9a5", hair: "5a3a1e", shirt: "c6f19d", pants: "24324a", hat: false };

const HEX = /^[0-9a-fA-F]{6}$/;

/** Strict: all four colours are 6-digit hex without "#" and hat is a boolean, otherwise null (extra keys are ignored). */
export function parseAvatar(value: unknown): Avatar | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const key of ["skin", "hair", "shirt", "pants"] as const) {
    if (typeof v[key] !== "string" || !HEX.test(v[key] as string)) return null;
  }
  if (typeof v.hat !== "boolean") return null;
  return { skin: (v.skin as string).toLowerCase(), hair: (v.hair as string).toLowerCase(), shirt: (v.shirt as string).toLowerCase(),
    pants: (v.pants as string).toLowerCase(), hat: v.hat };
}

/** The look saved by the site's profile page (localStorage `cc.avatar.v1`), or the default when missing, unreadable or invalid. */
export function loadAvatar(storage?: Pick<Storage, "getItem">): Avatar {
  try {
    const store = storage ?? window.localStorage;
    const raw = store.getItem(AVATAR_KEY);
    return (raw && parseAvatar(JSON.parse(raw))) || DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}

// 8 x 12 cells. h hair, c cap, s skin, t shirt, p trousers, b shoes, . empty
const BODY = [
  "..hhhh..",
  ".hhhhhh.",
  ".ssssss.",
  ".ssssss.",
  "..ssss..",
  ".tttttt.",
  "tttttttt",
  "tssttsst",
  ".pppppp.",
  ".pp..pp.",
  ".pp..pp.",
  ".bb..bb.",
];
const CAP_ROWS = ["..cccc..", "cccccccc"]; // crown and a brim one cell wider than the head
export const SPRITE_W = 8;
export const SPRITE_H = 12;

export interface SpriteRect { x: number; y: number; w: number; fill: string }

/** Run-length merged rectangles (in cells) for an avatar. The cap is drawn in the shirt colour. */
export function spriteRects(avatar: Avatar): SpriteRect[] {
  const colours: Record<string, string> = {
    h: `#${avatar.hair}`, c: `#${avatar.shirt}`, s: `#${avatar.skin}`, t: `#${avatar.shirt}`, p: `#${avatar.pants}`, b: "#151515",
  };
  const rows = avatar.hat ? [...CAP_ROWS, ...BODY.slice(2)] : BODY;
  const rects: SpriteRect[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      let end = x;
      while (end + 1 < row.length && row[end + 1] === ch) end++;
      if (ch !== ".") rects.push({ x, y, w: end - x + 1, fill: colours[ch]! });
      x = end + 1;
    }
  });
  return rects;
}
