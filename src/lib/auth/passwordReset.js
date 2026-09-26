import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { getDataDir } from "@/lib/dataDir.js";
import { updateSettings } from "@/lib/localDb";

// Recovery entry for a forgotten / unusable dashboard password (issue #33).
//
// Put a file named `reset-password` in the data directory:
//   - with a password in it  → that becomes the dashboard password
//   - empty                  → the stored password is removed and log-in falls back
//                              to the first-login password (INITIAL_PASSWORD /
//                              fnOS initial-password) — or, with none, to
//                              "set one on this machine"
// The file is consumed on the next server start or the next log-in attempt (no
// restart needed) and deleted before anything else, so the plaintext does not
// linger. Only someone who can write to the data directory can use it — and that
// person can already read the whole database, so it grants nothing new.
// fnOS writes it from App Center → 10Router → 应用设置 (cmd/config_callback).
export const PASSWORD_RESET_FILE = "reset-password";

export async function applyPasswordResetFile() {
  const file = path.join(getDataDir(), PASSWORD_RESET_FILE);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return null; // no reset requested
  }
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    console.warn(`[auth] could not delete ${file} after reading it — remove it by hand: ${e.message}`);
  }

  const newPassword = content.trim();
  if (!newPassword) {
    await updateSettings({ password: null });
    console.log("[auth] dashboard password removed via reset-password file (first-login password applies again)");
    return "cleared";
  }
  const hash = await bcrypt.hash(newPassword, await bcrypt.genSalt(10));
  await updateSettings({ password: hash });
  console.log("[auth] dashboard password replaced via reset-password file");
  return "set";
}
