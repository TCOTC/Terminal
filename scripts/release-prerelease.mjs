import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const tag = `v${version}`;
execFileSync(
    "gh",
    ["release", "create", tag, "package.zip", "--prerelease", "--notes", ""],
    { stdio: "inherit", cwd: root },
);
