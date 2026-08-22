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
  test("revokes the previous preview URL when a photo is replaced without being explicitly removed", () => {
    const { revoked } = stubObjectUrls();
    const onChange = vi.fn();

    const { container, rerender } = render(<EvidencePhotoInput value={null} onChange={onChange} />);
    const input = container.querySelector('input[type="file"]');

    act(() => {
      fireEvent.change(input, { target: { files: [makeFile("first.jpg")] } });
    });
    const firstFile = onChange.mock.calls[0][0];
    rerender(<EvidencePhotoInput value={firstFile} onChange={onChange} />);

    act(() => {
      fireEvent.change(input, { target: { files: [makeFile("second.jpg")] } });
    });

    expect(revoked).toContain("blob:mock-0");
  });

  test("revokes the preview URL on unmount", () => {
    const { revoked } = stubObjectUrls();
    const onChange = vi.fn();

    const { container, unmount } = render(<EvidencePhotoInput value={null} onChange={onChange} />);
    const input = container.querySelector('input[type="file"]');

    act(() => {
      fireEvent.change(input, { target: { files: [makeFile()] } });
    });

    unmount();

    expect(revoked.length).toBeGreaterThan(0);
  });
});
