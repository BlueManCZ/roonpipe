import fs from "node:fs";
import path from "node:path";

const file = path.join(__dirname, "..", "dist", "index.js");
const content = fs.readFileSync(file, "utf8");

if (!content.startsWith("#!")) {
    fs.writeFileSync(file, `#!/usr/bin/env node\n${content}`);
}
