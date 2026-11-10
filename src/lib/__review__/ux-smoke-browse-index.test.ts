// @vitest-environment node
/** Isolated Rust probes: extract production pure functions, compile with std-only rustc.
 * No Cargo/app build, IPC, drives walk, user files, or SSH. Unicode helpers are identity
 * stubs; all fixtures here are ASCII so these tests make no Unicode claims.
 */
import { beforeAll, expect, it } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { patternToMatcher } from "@/lib/glob";
import { spawnSync } from "node:child_process";

const index = readFileSync(
  resolve("src-tauri/src/services/file_index.rs"),
  "utf8",
);
const search = readFileSync(resolve("src-tauri/src/core/search.rs"), "utf8");
function block(source: string, start: string): string {
  const at = source.indexOf(start);
  if (at < 0) throw new Error(`Missing production declaration: ${start}`);
  const open = source.indexOf("{", at);
  let depth = 1;
  let end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  return source.slice(at, end).replace(/^\s*#\[serde\([^\n]*\)\]\s*$/gm, "");
}
const compare = readFileSync(resolve("src-tauri/src/core/compare.rs"), "utf8");
const frecency = readFileSync(
  resolve("src-tauri/src/services/frecency.rs"),
  "utf8",
);
const bin = resolve("node_modules/.cache/ux-smoke-browse-rust/probe");
beforeAll(() => {
  mkdirSync(resolve("node_modules/.cache/ux-smoke-browse-rust"), {
    recursive: true,
  });
  const code = `
#![allow(dead_code)]
use std::path::{Path,PathBuf};
#[derive(Clone,Copy,Debug,PartialEq)] pub enum EntryKind { File,Dir,Symlink,Other }
#[derive(Clone,Debug)] pub enum SourceId { Local, Ssh { connection_id: types::ConnectionId, host_ip: std::net::IpAddr, user: String } }
#[derive(Clone,Debug)] pub struct Location { source: SourceId, path: PathBuf }
mod types { #[derive(Clone,Debug)] pub struct ConnectionId(pub String); }
mod core { pub mod search { pub fn nfc_key(s: &str)->String{s.into()} pub fn pattern_forms(s:&str)->Vec<String>{vec![s.into()]} } }
${block(search, "pub struct SearchOpts")}
${block(search, "impl SearchOpts")}
${block(search, "impl Default for SearchOpts")}
#[derive(Debug)] ${block(search, "pub struct SearchHit")}
${block(index, "fn kind_to_u8")}
${block(index, "fn u8_to_kind")}
#[derive(Default)] ${block(index, "struct CompactIndex")}
${block(index, "impl CompactIndex")}
${block(index, "fn offsets_ok")}
#[derive(Default)] ${block(index, "struct CompactBuilder")}
${block(index, "impl CompactBuilder")}
${block(index, "pub struct IndexedPath")}
${block(index, "fn key_to_filename")}
${block(index, "fn run_query")}
${block(search, "pub fn parse_find_output")}
${block(compare, "fn glob_match")}
#[derive(Clone)] ${block(frecency, "pub struct FrecencyEntry")}
${block(frecency, "fn score")}
struct FrecencyStore { inner: std::sync::RwLock<Vec<FrecencyEntry>> }
impl FrecencyStore {
${block(frecency, "pub async fn query").replace("pub async fn", "pub fn").replace("self.inner.read().await", "self.inner.read().unwrap()")}
}
#[test] fn sc48_multiword() {
 let store=FrecencyStore{inner:std::sync::RwLock::new(vec![FrecencyEntry{location:Location{source:SourceId::Local,path:"/fixture/proj/app/src".into()},host_alias:None,count:1,last_visit_ms:0}])};
 assert_eq!(store.query("proj src",50,0).len(),1);
}
#[test] fn sc49_glob_case() { assert!(glob_match("*.LOG","trace.log")); }
#[test] fn sc49_glob_substring() { assert!(glob_match("node_modules","my_node_modules_cache")); }

#[test] fn sc25_cache_keys_distinct() {
  assert_ne!(key_to_filename("local|/fixture/a-b"),key_to_filename("local|/fixture/a_b"));
}
#[test] fn sc26_invalid_cache_rejected() {
  let mut b=CompactBuilder::new();
  b.push(&IndexedPath{path:"/fixture/a".into(),kind:EntryKind::File,size:1,modified_ms:None});
  let mut idx=b.finish(0); assert!(idx.is_consistent());
  idx.path_off[1]=u32::MAX; assert!(!idx.is_consistent());
  idx.path_off[1]=idx.paths.len() as u32; idx.sizes.clear(); assert!(!idx.is_consistent());
  assert!(!offsets_ok(&[0,1,2],"é",2));
}
#[test] fn sc27_hidden_paths_excluded() {
  let mut b=CompactBuilder::new();
  b.push(&IndexedPath{path:"/fixture/.cache/needle.txt".into(),kind:EntryKind::File,size:1,modified_ms:None});
  let idx=b.finish(0);
  assert_eq!(run_query(&idx,&SourceId::Local,"needle",&SearchOpts::default()).len(),0);
}
#[test] fn sc29_newline_is_one_name() {
  let hits=parse_find_output("/fixture/first\\nsecond.txt\\n",&types::ConnectionId("fixture".into()),"192.0.2.1".parse().unwrap(),"u");
  assert_eq!(hits.len(),1); assert_eq!(hits[0].name,"first\\nsecond.txt");
}
`;
  const file = resolve("node_modules/.cache/ux-smoke-browse-rust/probe.rs");
  writeFileSync(file, code);
  const compile = spawnSync(
    "rustc",
    ["--edition=2021", "--test", file, "-o", bin],
    { encoding: "utf8", timeout: 30000 },
  );
  expect(compile.status, compile.stderr).toBe(0);
}, 40000);
function run(name: string) {
  const result = spawnSync(bin, [name, "--exact", "--nocapture"], {
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
it.fails(
  "ux-smoke browse-s08 SC-25 distinct index roots must have distinct cache filenames",
  () => run("sc25_cache_keys_distinct"),
);
it("SC-26 malformed arrays/offsets are rejected by production consistency validator", () =>
  run("sc26_invalid_cache_rejected"));
it.fails(
  "ux-smoke browse-s09 SC-27 filename query must exclude hidden ancestors",
  () => run("sc27_hidden_paths_excluded"),
);
it.fails(
  "ux-smoke browse-s10 SC-29 newline in remote name must remain one hit",
  () => run("sc29_newline_is_one_name"),
);

// These are deliberately source audits, not runtime backend reproductions.
it("static, unverified SC-18 folder reindex does not update the preferred global index", () => {
  const commands = readFileSync(
    resolve("src-tauri/src/commands/search.rs"),
    "utf8",
  );
  expect(block(commands, "pub async fn index_reindex")).toContain(
    "build_index_for",
  );
  expect(block(commands, "async fn build_index_for")).toContain(
    "index.build_local",
  );
  expect(block(commands, "pub async fn index_search")).toContain(
    "query_global_local",
  );
  expect(block(commands, "pub async fn index_reindex")).not.toContain(
    "build_global",
  );
});
it("static, unverified SC-20 content search still does not apply SearchOpts metadata filters", () => {
  const local = block(search, "impl SearchBackend for LocalContentSearch");
  const remote = block(search, "impl SearchBackend for SshContentSearch");
  expect(local).not.toContain("opts.accepts");
  expect(remote).not.toMatch(
    /opts\.(accepts|min_size|max_size|modified_after_ms|modified_before_ms|only_kind)/,
  );
});
it("static, unverified SC-49 local content search silently skips above 8MiB", () => {
  expect(search).toContain(
    "const CONTENT_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;",
  );
  expect(block(search, "impl SearchBackend for LocalContentSearch")).toMatch(
    /if meta\.len\(\) > CONTENT_MAX_FILE_BYTES \{\s*continue;/,
  );
});

it.fails(
  "ux-smoke browse-s13 SC-48 jumper multiword query must match path components",
  () => run("sc48_multiword"),
);
it.fails(
  "ux-smoke browse-s14 SC-49 ignore glob case behavior must match FE matcher",
  () => {
    expect(patternToMatcher("*.LOG")("trace.log")).toBe(true);
    run("sc49_glob_case");
  },
);
it.fails(
  "ux-smoke browse-s15 SC-49 plain ignore pattern matching must match FE matcher",
  () => {
    expect(patternToMatcher("node_modules")("my_node_modules_cache")).toBe(
      true,
    );
    run("sc49_glob_substring");
  },
);
