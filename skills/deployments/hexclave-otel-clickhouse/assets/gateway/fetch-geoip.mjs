// Downloads DB-IP City Lite (CC BY 4.0, attribution link required), checks its sha256, and
// relabels database_type to GeoLite2-City, because the collector's geoip processor only accepts
// GeoIP2/GeoLite2 City databases. Falls back to the byte-identical npm mirror once DB-IP rotates
// the month out. Usage: node fetch-geoip.mjs <YYYY-MM> <dbip-city-lite npm version> <sha256 of .gz> <out.mmdb>
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [month, mirrorVersion, expectedSha256, out] = process.argv.slice(2);
const sources = [
  `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`,
  `https://cdn.jsdelivr.net/npm/dbip-city-lite@${mirrorVersion}/dbip-city-lite.mmdb.gz`,
];

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(gz).digest("hex");
  if (sha256 !== expectedSha256) throw new Error(`sha256 ${sha256}`);
  return gunzipSync(gz);
}

const mmdbString = (text) => Buffer.concat([Buffer.from([0x40 | text.length]), Buffer.from(text, "latin1")]);

function relabelAsGeoLite2City(db) {
  const metadataStart = db.lastIndexOf(Buffer.from("\xab\xcd\xefMaxMind.com", "latin1"));
  const typeKey = mmdbString("database_type");
  const dbipType = mmdbString("DBIP-City-Lite");
  const at = db.indexOf(Buffer.concat([typeKey, dbipType]), metadataStart);
  if (metadataStart < 0 || at < 0) throw new Error("database_type DBIP-City-Lite not found in the metadata");
  const valueStart = at + typeKey.length;
  return Buffer.concat([db.subarray(0, valueStart), mmdbString("GeoLite2-City"), db.subarray(valueStart + dbipType.length)]);
}

for (const url of sources) {
  try {
    writeFileSync(out, relabelAsGeoLite2City(await download(url)));
    console.log(`mmdb: ${url}`);
    process.exit(0);
  } catch (e) {
    console.error(`mmdb: ${url}: ${e.message}`);
  }
}
process.exit(1);
