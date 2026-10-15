import { defineTool } from "../registry.ts";

// ISO 8601 in local time with a numeric offset, e.g. 2026-10-15T19:45:12+01:00.
function localIso(d: Date): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

export const getTimeTool = defineTool({
  name: "get_time",
  description:
    "Get the current date and time on the user's machine. Use it whenever the answer depends on today's date or the current time. " +
    "Returns the local time in ISO 8601 with its UTC offset, followed by the IANA time zone name (e.g. Europe/Dublin). Takes no parameters.",
  input_schema: { type: "object", properties: {} },
  handler: async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return `${localIso(new Date())} (${zone})`;
  },
});
