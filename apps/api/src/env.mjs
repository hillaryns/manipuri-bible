import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const localEnvPath = fileURLToPath(new URL("../../../.env.local", import.meta.url));

if (existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
}
