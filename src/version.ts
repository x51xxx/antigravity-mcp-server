import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Read the version from package.json at runtime. A static import would place
// package.json under `rootDir: "./src"` and break the build layout, so this is
// resolved relative to this module (dist/version.js → ../package.json).
const pkg = require("../package.json") as { name: string; version: string };

export const SERVER_NAME: string = pkg.name;
export const SERVER_VERSION: string = pkg.version;
