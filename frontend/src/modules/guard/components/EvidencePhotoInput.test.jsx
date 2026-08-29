import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { EvidencePhotoInput } from "./EvidencePhotoInput.jsx";

// jsdom doesn't implement the Blob URL registry — stub it so createObjectURL
// returns a distinguishable, trackable value per call.
let nextUrlId = 0;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubObjectUrls() {
  const revoked = [];
  vi.stubGlobal(
    "URL",
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => `blob:mock-${nextUrlId++}`),
      revokeObjectURL: vi.fn((url) => revoked.push(url)),
    }),
  );
  return { revoked };
}

function makeFile(name = "photo.jpg") {
  return new File(["fake-bytes"], name, { type: "image/jpeg" });
}

describe("EvidencePhotoInput object URL lifecycle", () => {
  test("accumulates several photos instead of replacing the previous one", () => {
    stubObjectUrls();
    const onChange = vi.fn();

    const { container, rerender } = render(<EvidencePhotoInput value={[]} onChange={onChange} />);
    const input = container.querySelector('input[type="file"]');

    act(() => {
      fireEvent.change(input, { target: { files: [makeFile("first.jpg")] } });
    });
    const afterFirst = onChange.mock.calls[0][0];
    expect(afterFirst).toHaveLength(1);

    rerender(<EvidencePhotoInput value={afterFirst} onChange={onChange} />);
    act(() => {
      fireEvent.change(input, { target: { files: [makeFile("second.jpg")] } });
    });

    // A second capture ADDS to the set — a Guard photographing two angles
    // must not silently lose the first one.
    expect(onChange.mock.calls[1][0]).toHaveLength(2);
  });

  test("revokes a preview URL when its photo is removed from the set", () => {
    const { revoked } = stubObjectUrls();
    const onChange = vi.fn();

    const { container, rerender } = render(<EvidencePhotoInput value={[]} onChange={onChange} />);
    const input = container.querySelector('input[type="file"]');

    act(() => {
      fireEvent.change(input, { target: { files: [makeFile("first.jpg")] } });
    });
    const files = onChange.mock.calls[0][0];

    rerender(<EvidencePhotoInput value={files} onChange={onChange} />);
    act(() => {
      rerender(<EvidencePhotoInput value={[]} onChange={onChange} />);
    });

    expect(revoked.length).toBeGreaterThan(0);
  });

  test("revokes every preview URL on unmount", () => {
    const { revoked } = stubObjectUrls();
    const onChange = vi.fn();

    const { container, rerender, unmount } = render(<EvidencePhotoInput value={[]} onChange={onChange} />);
    const input = container.querySelector('input[type="file"]');

    act(() => {
      fireEvent.change(input, { target: { files: [makeFile()] } });
    });
    rerender(<EvidencePhotoInput value={onChange.mock.calls[0][0]} onChange={onChange} />);

    unmount();

    expect(revoked.length).toBeGreaterThan(0);
  });
});
