import type { Talk } from "@cc/shared";

const SOURCE_URL = "https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/";

/** RFC 5545 TEXT escaping; catalog text cannot inject calendar properties. */
export function escapeCalendarText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

/** Fold at 75 UTF-8 octets, counting the continuation space without splitting code points. */
export function foldCalendarLine(line: string): string {
  const parts: string[] = [];
  let part = "";
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    if (octets + size > 75) { parts.push(part); part = " "; octets = 1; }
    part += character;
    octets += size;
  }
  parts.push(part);
  return parts.join("\r\n");
}

function utc(date: string | Date): string {
  const value = new Date(date);
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid calendar time");
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** No attendee/session fields are accepted or emitted; UIDs are stable across exports. */
export function createCalendar(talks: Talk[], generatedAt: Date): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Conference Companion//Schedule//EN", "CALSCALE:GREGORIAN"];
  const seen = new Set<string>();
  for (const talk of talks) {
    if (seen.has(talk.id)) continue;
    seen.add(talk.id);
    if (Date.parse(talk.end) <= Date.parse(talk.start)) throw new Error("Invalid calendar interval");
    const description = `${Array.from(talk.abstract).slice(0, 500).join("")}\n${SOURCE_URL}`;
    lines.push("BEGIN:VEVENT", `UID:${escapeCalendarText(`${talk.id}@conference-companion`)}`,
      `DTSTAMP:${utc(generatedAt)}`, `DTSTART:${utc(talk.start)}`, `DTEND:${utc(talk.end)}`,
      `SUMMARY:${escapeCalendarText(talk.title)}`, `LOCATION:${escapeCalendarText(talk.room)}`,
      `DESCRIPTION:${escapeCalendarText(description)}`, `URL:${SOURCE_URL}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldCalendarLine).join("\r\n") + "\r\n";
}
