import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddMaterialDialog } from "./AddMaterialDialog.jsx";

// A Department Material Catalog entry links ONE department to one global
// Company Item, so the department is part of the request — not something the
// server can infer for an actor who belongs to no single department. A
// company-wide actor (CEO) has `departmentId === null`, so unless the dialog
// carries the department explicitly the create can never succeed for them.

const mockAddCatalogEntry = vi.hoisted(() => vi.fn());
const mockSearchCompanyItems = vi.hoisted(() => vi.fn());

vi.mock("../api.js", () => ({
  addCatalogEntry: (...args) => mockAddCatalogEntry(...args),
  searchCompanyItems: (...args) => mockSearchCompanyItems(...args),
}));

const UOMS = [{ id: "uom-bag", name: "Bags" }];
const DEPARTMENTS = [
  { id: "dept-civil", name: "Civil" },
  { id: "dept-elec", name: "Electrical" },
];

beforeEach(() => {
  mockSearchCompanyItems.mockResolvedValue({ data: [] });
  mockAddCatalogEntry.mockResolvedValue({ data: { id: "entry-1" } });
});

afterEach(() => {
  cleanup();
  mockAddCatalogEntry.mockReset();
  mockSearchCompanyItems.mockReset();
});

function open(props) {
  return render(
    <AddMaterialDialog open onClose={() => {}} onAdded={() => {}} unitsOfMeasure={UOMS} {...props} />,
  );
}

async function chooseNewMaterial(name) {
  fireEvent.change(screen.getByLabelText("Search materials"), { target: { value: name } });
  await act(async () => {});
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`Create.*${name}`, "i") }));
}

describe("AddMaterialDialog carries the department", () => {
  test("a department-scoped actor's create sends that department", async () => {
    open({ departmentId: "dept-civil", departments: [] });
    await chooseNewMaterial("Cable");
    fireEvent.change(screen.getByLabelText("Default unit"), { target: { value: "uom-bag" } });
    fireEvent.click(screen.getByRole("button", { name: /add material/i }));

    await waitFor(() =>
      expect(mockAddCatalogEntry).toHaveBeenCalledWith(
        expect.objectContaining({ departmentId: "dept-civil", defaultUomId: "uom-bag" }),
      ),
    );
  });

  test("a company-wide actor with no department of their own picks one, and it is sent", async () => {
    open({ departmentId: "", departments: DEPARTMENTS });
    await chooseNewMaterial("Paint");

    const departmentSelect = screen.getByLabelText("Department");
    fireEvent.change(departmentSelect, { target: { value: "dept-elec" } });
    fireEvent.change(screen.getByLabelText("Default unit"), { target: { value: "uom-bag" } });
    fireEvent.click(screen.getByRole("button", { name: /add material/i }));

    await waitFor(() =>
      expect(mockAddCatalogEntry).toHaveBeenCalledWith(
        expect.objectContaining({ departmentId: "dept-elec" }),
      ),
    );
  });

  test("confirming is blocked until a company-wide actor names the department", async () => {
    open({ departmentId: "", departments: DEPARTMENTS });
    await chooseNewMaterial("Paint");
    fireEvent.change(screen.getByLabelText("Default unit"), { target: { value: "uom-bag" } });

    expect(screen.getByRole("button", { name: /add material/i }).disabled).toBe(true);
    expect(mockAddCatalogEntry).not.toHaveBeenCalled();
  });

  test("a department-scoped actor is never offered a department choice", async () => {
    open({ departmentId: "dept-civil", departments: DEPARTMENTS });
    await chooseNewMaterial("Cable");
    expect(screen.queryByLabelText("Department")).toBeNull();
  });
});
