import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const secret = readFileSync(join(process.env.APPDATA, "10router", "jwt-secret"), "utf8").trim();
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const h = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: "1", role: "admin", iat: Math.floor(Date.now() / 1000) })}`;
const jwt = `${h}.${createHmac("sha256", secret).update(h).digest("base64url")}`;
const qd = ["auto","ultimate","performance","efficient","qmodel_38max","qfmodel","qmodel_latest","qmodel","kmodel_latest","kmodel","gmodel","gfmodel","dmodel","dfmodel","mmodel"];
const qdc = ["auto","qmodel_38max","qfmodel","qmodel_latest","qmodel","dmodel","dfmodel","gmodel","gfmodel","gm51model","kmodel_latest","kmodel","mmodel","q37fmodel"];
let ok = 0, fail = 0;
for (const [alias, ids] of [["qd", qd], ["qdc", qdc]]) {
  for (const id of ids) {
    const res = await fetch(`http://127.0.0.1:20128/api/models/custom?providerAlias=${alias}&id=${id}&type=llm`, { method: "DELETE", headers: { Cookie: `auth_token=${jwt}` } });
    res.ok ? ok++ : fail++;
  }
}
console.log(`deleted=${ok} failed=${fail}`);
