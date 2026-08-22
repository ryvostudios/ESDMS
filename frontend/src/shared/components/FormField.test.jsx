import { describe, test, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FormField, Input } from "./FormField.jsx";

afterEach(cleanup);

describe("FormField accessibility wiring", () => {
  test("links the input to its error text via aria-describedby, and marks it invalid", () => {
    render(
      <FormField label="Email" htmlFor="email" error="Email is required">
        <Input id="email" name="email" error="Email is required" />
      </FormField>,
    );

    const input = screen.getByLabelText("Email");
    const error = screen.getByRole("alert");

    expect(error.getAttribute("id")).toBe("email-error");
    expect(input.getAttribute("aria-describedby")).toBe("email-error");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  test("links the input to its hint text when there is no error", () => {
    render(
      <FormField label="Vehicle" htmlFor="vehicle" hint="e.g. ABC-123">
        <Input id="vehicle" name="vehicle" />
      </FormField>,
    );

    const input = screen.getByLabelText("Vehicle");
    expect(input.getAttribute("aria-describedby")).toBe("vehicle-hint");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});
