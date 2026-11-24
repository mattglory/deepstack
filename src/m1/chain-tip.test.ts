// One chain tip per snapshot (rpc.ts atChainTip, tip-balances.ts; review R105-1).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Cl } from "@stacks/transactions";
import { atChainTip, currentChainTip, hiroFetch, withTipParam } from "./rpc.js";
import { nodeFtBalance, nodeStxBalance } from "./tip-balances.js";

const TIP = "24f9cc674ef73daf1587990101b2d076a33a7dc3a0a13dbc13f6f5d6c271dcb6";
const ADDR = "SP33TPST13VDWXV25YS08PDYJ383597BJJYHP4YV4";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fake node: answers by path, records every URL. `block` is what the indexer reports as latest. */
function fakeNode(block: unknown = { results: [{ height: 9_562_434, index_block_hash: `0x${TIP}` }] }) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/extended/v2/blocks?limit=1")) return new Response(JSON.stringify(block), { status: 200 });
    if (url.includes(`/v2/accounts/${ADDR}`)) return new Response(JSON.stringify({ balance: "0x000000000000000000000000092d7431", locked: "0x0", nonce: 96 }), { status: 200 });
    if (url.includes("/sbtc-token/get-balance")) return new Response(JSON.stringify({ okay: true, result: `0x${Cl.serialize(Cl.ok(Cl.uint(176_701)))}` }), { status: 200 });
    if (url.includes("/no-balance-token/get-balance")) return new Response(JSON.stringify({ okay: true, result: `0x${Cl.serialize(Cl.error(Cl.uint(1)))}` }), { status: 200 });
    throw new Error(`fake node: unexpected ${url}`);
  }) as typeof fetch;
  return urls;
}

test("withTipParam: node reads get tip=; indexer, broadcast and already-pinned URLs are unchanged", () => {
  const b = "https://api.hiro.so";
  assert.equal(withTipParam(`${b}/v2/contracts/call-read/SP1.c/get-pool`, TIP), `${b}/v2/contracts/call-read/SP1.c/get-pool?tip=${TIP}`);
  assert.equal(withTipParam(`${b}/v2/accounts/${ADDR}?proof=0`, TIP), `${b}/v2/accounts/${ADDR}?proof=0&tip=${TIP}`);
  assert.equal(withTipParam(`${b}/v2/map_entry/SP1/c/m`, TIP), `${b}/v2/map_entry/SP1/c/m?tip=${TIP}`);
  for (const u of [`${b}/extended/v1/address/${ADDR}/balances`, `${b}/v2/transactions`, `${b}/v2/info`, `${b}/v2/contracts/call-read/SP1.c/f?tip=abc`]) {
    assert.equal(withTipParam(u, TIP), u);
  }
});

test("hiroFetch pins node reads only inside atChainTip; parallel snapshots keep their own tips", async () => {
  const urls = fakeNode();
  const read = (b: string) => hiroFetch(b)(`${b}/v2/accounts/${ADDR}?proof=0`);
  await read("https://api.hiro.so");
  assert.equal(urls.at(-1), `https://api.hiro.so/v2/accounts/${ADDR}?proof=0`, "outside a snapshot: unpinned, as before");
  assert.equal(currentChainTip(), undefined);

  const seen = await atChainTip(async (tip) => {
    assert.deepEqual(tip, { hash: TIP, height: 9_562_434 }, "0x stripped, height kept");
    await read("https://api.hiro.so");
    return currentChainTip();
  });
  assert.equal(seen, TIP);
  assert.ok(urls.at(-1)!.endsWith(`?proof=0&tip=${TIP}`));
  assert.equal(currentChainTip(), undefined, "the pin ends with the snapshot");
});

test("atChainTip fails closed on a malformed latest block: the snapshot never runs", async () => {
  for (const bad of [{ results: [] }, { results: [{ height: 1, index_block_hash: "0x1234" }] }, { results: [{ height: "x", index_block_hash: `0x${TIP}` }] }]) {
    fakeNode(bad);
    let ran = false;
    await assert.rejects(atChainTip(async () => { ran = true; }), /latest block/);
    assert.equal(ran, false);
  }
});

test("node balances: STX from /v2/accounts, SIP-010 from get-balance, both pinned; an err result throws", async () => {
  const urls = fakeNode();
  const [stx, sbtc] = await atChainTip(() => Promise.all([nodeStxBalance(ADDR), nodeFtBalance(ADDR, SBTC)]));
  assert.equal(stx, 153_973_809n, "matches the indexer's balance for the same wallet (2026-11-24)");
  assert.equal(sbtc, 176_701n);
  assert.ok(urls.filter((u) => u.includes("/v2/") && !u.includes("/extended/")).every((u) => u.endsWith(`tip=${TIP}`)), "every balance read pinned");
  await assert.rejects(nodeFtBalance(ADDR, "SP1.no-balance-token::t"), /unexpected result/);
  await assert.rejects(nodeFtBalance(ADDR, "not-a-contract"), /not a token asset id/);
});
