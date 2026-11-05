import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The api suites write throwaway keys, staging and mock-SP dirs under the OS temp dir for the
// processes they spawn, so the dirs can only go once every test file has finished. This teardown
// removes the stamper-wp0* dirs created during this run and leaves older or concurrent ones alone.
const PREFIX = /^stamper-wp0[678]-/;

export default function setup(): () => void {
  const startedAt = Date.now() - 1_000;
  return () => {
    const root = tmpdir();
    for (const name of readdirSync(root)) {
      if (!PREFIX.test(name)) continue;
      const dir = join(root, name);
      try {
        if (statSync(dir).birthtimeMs >= startedAt) rmSync(dir, { recursive: true, force: true });
      } catch {
        // already gone or not ours to stat: ignore
      }
    }
  };
}
