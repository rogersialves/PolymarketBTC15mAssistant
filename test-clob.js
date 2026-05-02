import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import {
  AssetType,
  Chain,
  ClobClient,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";

const pkRaw = process.env.POLY_PRIVATE_KEY;
const host = process.env.POLY_CLOB_HOST || "https://clob.polymarket.com";
const chainId = parseInt(process.env.POLY_CHAIN_ID || "137", 10);

function normalizePrivateKeyHex(key) {
  const s = String(key || "").trim();
  if (!s) return null;
  return s.startsWith("0x") ? s : `0x${s}`;
}

const pkHex = normalizePrivateKeyHex(pkRaw);
if (!pkHex) {
  console.error("POLY_PRIVATE_KEY required");
  process.exit(1);
}

const account = privateKeyToAccount(pkHex);
const clobChain = chainId === Chain.AMOY ? Chain.AMOY : Chain.POLYGON;
const viemChain = chainId === Chain.AMOY ? polygonAmoy : polygon;
const rpcUrl = process.env.POLY_RPC_URL?.trim();
const transport = rpcUrl ? http(rpcUrl) : http();
const signer = createWalletClient({ account, chain: viemChain, transport });

console.log("EOA:", account.address);

(async () => {
  const tempClient = new ClobClient({
    host,
    chain: clobChain,
    signer,
    signatureType: SignatureTypeV2.EOA,
  });
  let creds;
  try {
    creds = await tempClient.deriveApiKey();
    console.log("API Key derived:", `${creds?.key?.slice(0, 8)}...`);
  } catch (e) {
    console.log("deriveApiKey error:", e.message);
    process.exit(1);
  }

  try {
    const c0 = new ClobClient({
      host,
      chain: clobChain,
      signer,
      creds,
      signatureType: SignatureTypeV2.EOA,
    });
    const b0 = await c0.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("Balance EOA:", JSON.stringify(b0));
  } catch (e) {
    console.log("Balance EOA error:", e.message);
  }

  try {
    const c1 = new ClobClient({
      host,
      chain: clobChain,
      signer,
      creds,
      signatureType: SignatureTypeV2.POLY_PROXY,
    });
    const b1 = await c1.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("Balance POLY_PROXY (no funder):", JSON.stringify(b1));
  } catch (e) {
    console.log("Balance POLY_PROXY error:", e.message);
  }

  try {
    const c1f = new ClobClient({
      host,
      chain: clobChain,
      signer,
      creds,
      signatureType: SignatureTypeV2.POLY_PROXY,
      funderAddress: account.address,
    });
    const b1f = await c1f.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("Balance POLY_PROXY (funder=EOA):", JSON.stringify(b1f));
  } catch (e) {
    console.log("Balance POLY_PROXY+funder error:", e.message);
  }
})();
