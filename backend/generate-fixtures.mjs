import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./test/fixtures/pdf/", import.meta.url));
await mkdir(dir, { recursive: true });

function zp(num, len) {
  return num.toString().padStart(len, "0");
}

function makeHeader() {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
}

function buildPdfWithText(text) {
  const header = makeHeader();
  const hLen = header.length;

  const obj1 = Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const obj2 = Buffer.from("2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n");
  const obj3 = Buffer.from("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  const obj4 = Buffer.from("4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox[0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>\nendobj\n");

  const streamContent = "BT\n/F1 10 Tf\n72 720 Td\n(" + text + ") Tj\nET";
  const obj5 = Buffer.from("5 0 obj\n<< /Length " + streamContent.length + " >>\nstream\n" + streamContent + "\nendstream\nendobj\n");

  const off1 = hLen;
  const off2 = hLen + obj1.length;
  const off3 = off2 + obj2.length;
  const off4 = off3 + obj3.length;
  const off5 = off4 + obj4.length;
  const xrefStart = off5 + obj5.length;

  let xref = "xref\n0 6\n";
  xref += zp(0, 10) + " 65535 f \n";
  xref += zp(off1, 10) + " 00000 n \n";
  xref += zp(off2, 10) + " 00000 n \n";
  xref += zp(off3, 10) + " 00000 n \n";
  xref += zp(off4, 10) + " 00000 n \n";
  xref += zp(off5, 10) + " 00000 n \n";

  const trailer = "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n";

  return Buffer.concat([header, obj1, obj2, obj3, obj4, obj5, Buffer.from(xref), Buffer.from(trailer)]);
}

function buildMultiPagePdf(pageTexts) {
  const header = makeHeader();
  const hLen = header.length;
  const n = pageTexts.length;

  const obj1 = Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids = [];
  for (let i = 0; i < n; i++) kids.push((4 + i * 2).toString() + " 0 R");
  const obj2 = Buffer.from("2 0 obj\n<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + n + " >>\nendobj\n");
  const obj3 = Buffer.from("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  const pageObjs = [];
  const streamObjs = [];
  for (let i = 0; i < n; i++) {
    const pn = 4 + i * 2;
    const sn = pn + 1;
    const sc = "BT\n/F1 10 Tf\n72 720 Td\n(" + pageTexts[i] + ") Tj\nET";
    streamObjs.push(Buffer.from(sn + " 0 obj\n<< /Length " + sc.length + " >>\nstream\n" + sc + "\nendstream\nendobj\n"));
    pageObjs.push(Buffer.from(pn + " 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox[0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents " + sn + " 0 R >>\nendobj\n"));
  }

  const offs = [hLen, hLen + obj1.length, hLen + obj1.length + obj2.length, hLen + obj1.length + obj2.length + obj3.length];
  let cum = offs[3];
  for (let i = 0; i < n; i++) {
    offs.push(cum);
    cum += pageObjs[i].length;
    offs.push(cum);
    cum += streamObjs[i].length;
  }
  const xrefStart = cum;
  const totalEntries = offs.length + 1;

  let xref = "xref\n0 " + totalEntries + "\n";
  xref += zp(0, 10) + " 65535 f \n";
  for (let i = 0; i < offs.length; i++) {
    xref += zp(offs[i], 10) + " 00000 n \n";
  }

  const trailer = "trailer\n<< /Size " + totalEntries + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n";

  const pageAndStreamObjs = pageObjs.flatMap((pageObj, index) => [
    pageObj,
    streamObjs[index],
  ]);
  return Buffer.concat([header, obj1, obj2, obj3, ...pageAndStreamObjs, Buffer.from(xref), Buffer.from(trailer)]);
}

function buildBlankPdf() {
  const header = makeHeader();
  const hLen = header.length;

  const obj1 = Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const obj2 = Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  const obj3 = Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox[0 0 612 792] >>\nendobj\n");

  const off1 = hLen;
  const off2 = hLen + obj1.length;
  const off3 = hLen + obj1.length + obj2.length;
  const xrefStart = hLen + obj1.length + obj2.length + obj3.length;

  let xref = "xref\n0 4\n";
  xref += zp(0, 10) + " 65535 f \n";
  xref += zp(off1, 10) + " 00000 n \n";
  xref += zp(off2, 10) + " 00000 n \n";
  xref += zp(off3, 10) + " 00000 n \n";

  const trailer = "trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF\n";

  return Buffer.concat([header, obj1, obj2, obj3, Buffer.from(xref), Buffer.from(trailer)]);
}

// Generate
const textPdf = buildPdfWithText("Hello World Fixture");
await writeFile(dir + "/text.pdf", textPdf);
console.log("Created text.pdf (" + textPdf.length + " bytes)");

const multiPdf = buildMultiPagePdf([
  "FIRST PAGE MARKER\nThis is the content of the first page.",
  "SECOND PAGE MARKER\nThis is the content of the second page.",
]);
await writeFile(dir + "/multipage.pdf", multiPdf);
console.log("Created multipage.pdf (" + multiPdf.length + " bytes)");

const blankPdf = buildBlankPdf();
await writeFile(dir + "/no-text.pdf", blankPdf);
console.log("Created no-text.pdf (" + blankPdf.length + " bytes)");

await writeFile(dir + "/malformed.pdf", Buffer.from("This is not a valid PDF file at all.\x00\x01\x02"));
console.log("Created malformed.pdf");
console.log("All fixtures created.");
