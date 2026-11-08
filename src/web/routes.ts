import { handler } from "../routes/Home.ts";
import type { Route } from "./router.ts";

// Static, code-owned GET/HEAD registrations. No filesystem discovery or dynamic imports.
export const routes: readonly Route[] = [{ path: "/", handler }];
