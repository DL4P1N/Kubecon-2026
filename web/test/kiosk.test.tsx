import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Kiosk } from "../src/pages/Kiosk.js";
import { api } from "../src/api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fill(room: string, token: string) {
  fireEvent.change(screen.getByLabelText("Room"), { target: { value: room } });
  fireEvent.change(screen.getByLabelText(/Token/), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Check access" }));
}

it("shows a granted result as text and an icon in a live region", async () => {
  const scan = vi.spyOn(api, "scan").mockResolvedValue({ decision: "allow", room: "Hall DE" });
  render(<Kiosk />);
  fill(" Hall DE ", " tok ");
  const region = screen.getByRole("status");
  expect(await screen.findByText("Access granted")).toBeTruthy();
  expect(region.textContent).toContain("Access granted");
  expect(scan).toHaveBeenCalledWith({ token: "tok", room: "Hall DE" });
});

it("shows a denied result with a readable reason", async () => {
  vi.spyOn(api, "scan").mockResolvedValue({ decision: "deny", room: "Hall DE", reason: "token_expired" });
  render(<Kiosk />);
  fill("Hall DE", "tok");
  expect(await screen.findByText("Access denied")).toBeTruthy();
  expect(screen.getByText(/expired/)).toBeTruthy();
});

it("asks for a room and a token before calling the server", () => {
  const scan = vi.spyOn(api, "scan");
  render(<Kiosk />);
  fireEvent.click(screen.getByRole("button", { name: "Check access" }));
  expect(screen.getByRole("alert").textContent).toContain("Choose a room");
  expect(scan).not.toHaveBeenCalled();
});

it("treats a 401 deny body as a result and other failures as an error", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ decision: "deny", room: "r", reason: "token_invalid" }), { status: 401 }))
    .mockResolvedValueOnce(new Response("{}", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await api.scan({ token: "t", room: "r" })).toEqual({ decision: "deny", room: "r", reason: "token_invalid" });
  await expect(api.scan({ token: "t", room: "r" })).rejects.toThrow();
});

// ---- camera (html5-qrcode is mocked; no real camera in tests)
const camera = vi.hoisted(() => ({
  onSuccess: null as null | ((t: string) => void),
  release: null as null | (() => void),
  gate: false,
  stops: 0,
}));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    async start(_c: unknown, _cfg: unknown, onSuccess: (t: string) => void) {
      camera.onSuccess = onSuccess;
      if (camera.gate) await new Promise<void>((r) => (camera.release = r));
    }
    async stop() {
      camera.stops++;
    }
    clear() {}
  },
}));

it("sends one scan for repeated decodes of the same QR", async () => {
  camera.gate = false;
  camera.stops = 0;
  camera.onSuccess = null;
  const scan = vi.spyOn(api, "scan").mockResolvedValue({ decision: "allow", room: "Hall DE" });
  render(<Kiosk />);
  fireEvent.change(screen.getByLabelText("Room"), { target: { value: "Hall DE" } });
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  await vi.waitFor(() => expect(camera.onSuccess).not.toBeNull());
  camera.onSuccess!("tok");
  camera.onSuccess!("tok");
  camera.onSuccess!("tok");
  await screen.findByText("Access granted");
  expect(scan).toHaveBeenCalledTimes(1);
});

it("releases the camera when unmounted while it is still starting", async () => {
  camera.gate = true;
  camera.stops = 0;
  camera.release = null;
  const { unmount } = render(<Kiosk />);
  fireEvent.click(screen.getByRole("button", { name: "Scan with camera" }));
  await vi.waitFor(() => expect(camera.release).not.toBeNull());
  unmount();
  camera.release!();
  await vi.waitFor(() => expect(camera.stops).toBe(1));
  camera.gate = false;
});
