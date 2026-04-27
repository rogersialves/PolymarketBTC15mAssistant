import { ethers } from "ethers";

async function run() {
    const pk = process.env.POLY_PRIVATE_KEY;
    const host = process.env.POLY_CLOB_HOST || "https://clob.polymarket.com";
    const chainId = parseInt(process.env.POLY_CHAIN_ID || "137");

    const wallet = new ethers.Wallet(pk);
    console.log("EOA:", wallet.address);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const domain = {
        name: "ClobClient",
        version: "1",
        chainId: chainId
    };
    const types = {
        ClobAuth: [
            { name: "address", type: "address" },
            { name: "timestamp", type: "string" },
            { name: "nonce", type: "uint256" },
            { name: "message", type: "string" }
        ]
    };
    const message = "Derive Polymarket API Key";
    const nonce = 0;
    const value = {
        address: wallet.address,
        timestamp: timestamp,
        nonce: nonce,
        message: message
    };
    
    const sig = await wallet.signTypedData(domain, types, value);
    
    const l1Headers = {
        "POLY-ADDRESS": wallet.address,
        "POLY-SIGNATURE": sig,
        "POLY-TIMESTAMP": timestamp,
        "POLY-NONCE": nonce.toString(),
        "Accept": "application/json"
    };

    console.log("Headers:", JSON.stringify(l1Headers, null, 2));

    try {
        const r = await fetch(host + "/auth/derive-api-key", { method: "GET", headers: l1Headers });
        const text = await r.text();
        console.log("Response [" + r.status + "]:", text);
    } catch(e) {
        console.log("Error:", e.message);
    }
}
run().catch(console.error);
