import PDFDocument from "pdfkit";

// Records the box every text()/image() call actually occupied, per page, so
// a test can assert that nothing drawn on a page overlaps anything else —
// the property a reader cares about, independent of any fixed coordinates.
export function recordLayout() {
  const boxes = [];
  const originalText = PDFDocument.prototype.text;
  const originalImage = PDFDocument.prototype.image;

  PDFDocument.prototype.text = function recordedText(text, ...args) {
    const [xArg, yArg] = args;
    const options = args.find((arg) => arg && typeof arg === "object") || {};
    const x = typeof xArg === "number" ? xArg : this.x;
    const y = typeof yArg === "number" ? yArg : this.y;
    const page = this.page;
    const margin = this.page.margins.right;
    const width = options.width ?? Math.min(this.widthOfString(String(text)), this.page.width - margin - x);
    const result = originalText.call(this, text, ...args);
    boxes.push({
      kind: "text",
      text: String(text),
      page,
      spilled: this.page !== page,
      x,
      y,
      width,
      bottom: this.page === page ? this.y : page.height - page.margins.bottom,
      pageWidth: page.width,
      pageHeight: page.height,
    });
    return result;
  };

  PDFDocument.prototype.image = function recordedImage(src, x, y, options = {}) {
    const width = options.fit?.[0] ?? options.width;
    const height = options.fit?.[1] ?? options.height ?? width;
    boxes.push({ kind: "image", text: "[image]", page: this.page, x, y, width, bottom: y + height, pageWidth: this.page.width, pageHeight: this.page.height });
    return originalImage.call(this, src, x, y, options);
  };

  function pages() {
    return [...new Set(boxes.map((box) => box.page))];
  }

  function overlaps() {
    const found = [];
    for (const page of pages()) {
      const onPage = boxes.filter((box) => box.page === page && box.text.trim() !== "");
      for (let i = 0; i < onPage.length; i += 1) {
        for (let j = i + 1; j < onPage.length; j += 1) {
          const a = onPage[i];
          const b = onPage[j];
          const tolerance = 0.5;
          const horizontal = a.x + a.width - tolerance > b.x && b.x + b.width - tolerance > a.x;
          const vertical = a.bottom - tolerance > b.y && b.bottom - tolerance > a.y;
          if (horizontal && vertical) found.push(`${a.text.slice(0, 40)} <-> ${b.text.slice(0, 40)}`);
        }
      }
    }
    return found;
  }

  function outOfBounds() {
    return boxes
      .filter((box) => box.text.trim() !== "")
      .filter((box) => box.spilled || box.x < 0 || box.x + box.width > box.pageWidth || box.bottom > box.pageHeight)
      .map((box) => box.text.slice(0, 40));
  }

  return {
    boxes,
    pageCount: () => pages().length,
    overlaps,
    outOfBounds,
    restore() {
      PDFDocument.prototype.text = originalText;
      PDFDocument.prototype.image = originalImage;
    },
  };
}
