import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GateActionForm } from "./GateActionForm.jsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /confirm exit|complete return/i }));
  });
}

describe("GateActionForm — photos are optional evidence, the odometer is not", () => {
  test.each([
    ["EXIT", "Departure Photos (optional)", "Departure Odometer"],
    ["RETURN", "Return Photos (optional)", "Return Odometer"],
  ])("%s submits without a photo and labels the photo optional", async (mode, photoLabel, odometerLabel) => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<GateActionForm mode={mode} minOdometer={mode === "RETURN" ? 100 : null} onSubmit={onSubmit} />);

    expect(screen.getByText(photoLabel)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(new RegExp(odometerLabel)), { target: { value: "150" } });
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ odometer: 150, photos: [] }));
  });

  test.each(["EXIT", "RETURN"])("%s still requires a valid odometer reading", async (mode) => {
    const onSubmit = vi.fn();
    render(<GateActionForm mode={mode} minOdometer={mode === "RETURN" ? 100 : null} onSubmit={onSubmit} />);

    await submit();
    expect(screen.getByText("Enter a valid odometer reading.")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("return below the departure reading is still rejected", async () => {
    const onSubmit = vi.fn();
    render(<GateActionForm mode="RETURN" minOdometer={100} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Return Odometer/), { target: { value: "99" } });
    await submit();
    expect(screen.getByText("Must be at least 100 (departure reading).")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a selected photo is still submitted with the movement", async () => {
    vi.stubGlobal("URL", Object.assign(globalThis.URL, { createObjectURL: vi.fn(() => "blob:mock"), revokeObjectURL: vi.fn() }));
    const onSubmit = vi.fn(() => Promise.resolve());
    const { container } = render(<GateActionForm mode="EXIT" minOdometer={null} onSubmit={onSubmit} />);

    const photo = new File(["bytes"], "gate.jpg", { type: "image/jpeg" });
    act(() => {
      fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [photo] } });
    });
    fireEvent.change(screen.getByLabelText(/Departure Odometer/), { target: { value: "10" } });
    await submit();

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ odometer: 10, photos: [photo] }));
  });
});
