import { readFile } from "node:fs/promises";
import { getDocumentProxy, extractText } from "unpdf";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = join(
  fileURLToPath(import.meta.url),
  "..",
  "test",
  "fixtures",
  "pdf",
);

async function testFile(name, expectError = false) {
  console.log(`\n=== ${name} ===`);
  try {
    const data = await readFile(join(fixturesDir, name));
    const pdf = await getDocumentProxy(new Uint8Array(data));
    console.log("numPages:", pdf.numPages);
    const result = await extractText(pdf, { mergePages: false });
    console.log("totalPages:", result.totalPages);
    console.log("text:", JSON.stringify(result.text));
    console.log("trimmed:", JSON.stringify(result.text.map((t) => t.trim())));
    if (expectError) {
      console.error(`${name} parsed successfully but should be malformed`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.log("Error name:", err?.name);
    console.log("Error message:", err?.message?.substring(0, 200));
    if (!expectError) {
      process.exitCode = 1;
    }
  }
}

await testFile("text.pdf");
await testFile("multipage.pdf");
await testFile("no-text.pdf");
await testFile("malformed.pdf", true);
