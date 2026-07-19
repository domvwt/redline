#!/usr/bin/env node
// Global `redline` entrypoint: runs the TypeScript server via tsx.
import { register } from "tsx/esm/api";
register();
await import("../server/src/index.ts");
